import { Server as SocketIOServer } from 'socket.io';
import env from '../config/env';
import logger from '../config/logger';
import {
  SocketConnectionMeta,
  PingPayload,
  PongPayload,
  HealthCheckResult,
  TypedSocket,
  ServerToClientEvents,
  ClientToServerEvents,
  InterServerEvents,
  SocketData,
} from './socket.types';
import { messageQueueService } from './messageQueue';
import authService from '../services/authService';

/**
 * Interval (ms) between server-initiated ping events.
 * Defaults to 25 s, overridable via SOCKET_PING_INTERVAL_MS env var.
 */
const PING_INTERVAL_MS = env.SOCKET_PING_INTERVAL_MS;

/**
 * Maximum number of consecutive missed pongs before a connection is
 * considered stale and forcibly disconnected.
 * Defaults to 2, overridable via SOCKET_MAX_MISSED_PONGS env var.
 */
const MAX_MISSED_PONGS = env.SOCKET_MAX_MISSED_PONGS;

/**
 * SocketService manages all business-logic concerns for WebSocket
 * connections: connection tracking, ping/pong health checks, stale
 * connection eviction, and room cleanup on disconnect.
 */
export class SocketService {
  /** In-memory registry of active connections, keyed by socket ID. */
  private readonly connections = new Map<string, SocketConnectionMeta>();

  /** Reference to the running ping interval, if any. */
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * Register a new connection and begin tracking it.
   *
   * @param socket - The incoming socket instance.
   * @param userId - Optional authenticated user ID extracted from auth token.
   */
  public registerConnection(socket: TypedSocket, userId?: string, tokenExp?: number): void {
    const meta: SocketConnectionMeta = {
      tokenExp: tokenExp,
      socketId: socket.id,
      userId,
      connectedAt: Date.now(),
      lastPongAt: Date.now(),
      missedPongs: 0,
      rooms: [socket.id], // every socket starts in its own room
    };

    this.connections.set(socket.id, meta);

    if (userId) {
      const flushed = messageQueueService.flush(userId, (event, payload, ackCallback) => {
        (socket.emit as (event: string, payload: unknown, ack?: unknown) => void)(
          event,
          payload,
          ackCallback,
        );
      });

      if (flushed > 0) {
        logger.info(
          `[Socket] Flushed ${flushed} queued message(s) for userId=${userId} on reconnect`,
        );
      }
    }

    logger.info(
      `[Socket] Connected — id=${socket.id}${userId ? ` userId=${userId}` : ''} | ` +
        `total=${this.connections.size}`,
    );
  }

  /**
   * Handle an incoming pong from a client, resetting the missed-pong
   * counter and recording latency.
   *
   * @param socket  - The socket that sent the pong.
   * @param payload - Pong payload containing the original ping timestamp.
   */
  public handlePong(socket: TypedSocket, payload: PongPayload): void {
    const meta = this.connections.get(socket.id);
    if (!meta) {
      logger.warn(`[Socket] Pong received for unknown socket id=${socket.id}`);
      return;
    }

    const now = Date.now();
    const latency = now - (payload.timestamp ?? now);

    meta.lastPongAt = now;
    meta.missedPongs = 0;

    logger.debug(
      `[Socket] Pong — id=${socket.id} latency=${latency}ms | ` +
        `userId=${meta.userId ?? 'anonymous'}`,
    );
  }

  /**
   * Clean up state for a disconnected socket:
   *   - removes the connection record
   *   - leaves all rooms (Socket.IO auto-leaves, but we clear our registry)
   *
   * @param socket - The socket that disconnected.
   * @param reason - Disconnect reason string provided by Socket.IO.
   */
  public handleDisconnect(socket: TypedSocket, reason: string): void {
    const meta = this.connections.get(socket.id);

    if (!meta) {
      logger.warn(`[Socket] Disconnect event for untracked socket id=${socket.id}`);
      return;
    }

    const connectedDurationMs = Date.now() - meta.connectedAt;

    logger.info(
      `[Socket] Disconnected — id=${socket.id}` +
        `${meta.userId ? ` userId=${meta.userId}` : ''} | ` +
        `reason="${reason}" | ` +
        `duration=${connectedDurationMs}ms | ` +
        `rooms=${meta.rooms.join(', ')} | ` +
        `remaining=${this.connections.size - 1}`,
    );

    // Remove the connection record
    this.connections.delete(socket.id);
  }

  /**
   * Update the room list recorded for a connection whenever the socket
   * joins a new room.
   *
   * @param socketId - The socket that joined.
   * @param room     - The room name.
   */
  public trackRoomJoin(socketId: string, room: string): void {
    const meta = this.connections.get(socketId);
    if (meta && !meta.rooms.includes(room)) {
      meta.rooms.push(room);
    }
  }

  /**
   * Update the room list recorded for a connection whenever the socket
   * leaves a room.
   *
   * @param socketId - The socket that left.
   * @param room     - The room name.
   */
  public trackRoomLeave(socketId: string, room: string): void {
    const meta = this.connections.get(socketId);
    if (meta) {
      meta.rooms = meta.rooms.filter((r) => r !== room);
    }
  }

  /**
   * Start the periodic health-check loop.
   * Each tick pings every connected client and evicts those that have
   * exceeded the maximum missed-pong threshold.
   *
   * @param io - The Socket.IO server instance.
   */
  public startHealthChecks(
    io: SocketIOServer<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>,
  ): void {
    if (this.healthCheckInterval) {
      logger.warn('[Socket] Health-check loop is already running');
      return;
    }

    logger.info(
      `[Socket] Starting health-check loop — interval=${PING_INTERVAL_MS}ms maxMissedPongs=${MAX_MISSED_PONGS}`,
    );

    this.healthCheckInterval = setInterval(() => {
      this.runHealthCheckTick(io);
    }, PING_INTERVAL_MS);
  }

  /**
   * Stop the periodic health-check loop.
   */
  public stopHealthChecks(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
      logger.info('[Socket] Health-check loop stopped');
    }
  }

  /**
   * Execute a single health-check tick:
   *   1. Evict connections that have missed too many pongs.
   *   2. Send a ping to every remaining connected socket.
   *
   * @param io - The Socket.IO server instance.
   * @returns  A summary of the tick results.
   */
  public runHealthCheckTick(
    io: SocketIOServer<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>,
  ): HealthCheckResult {
    const checkedAt = new Date().toISOString();
    let staleConnectionsEvicted = 0;

    for (const [socketId, meta] of this.connections) {
      meta.missedPongs += 1;

      if (meta.missedPongs > MAX_MISSED_PONGS) {
        logger.warn(
          `[Socket] Evicting stale connection — id=${socketId}` +
            `${meta.userId ? ` userId=${meta.userId}` : ''} | ` +
            `missedPongs=${meta.missedPongs}`,
        );

        const socket = io.sockets.sockets.get(socketId);
        if (socket) {
          socket.disconnect(true);
        } else {
          // Socket already gone at the transport level — just remove the record
          this.connections.delete(socketId);
        }

        staleConnectionsEvicted += 1;
      } else {
        // Send ping and wait for pong response
        // Send ping and wait for pong response
        const pingPayload: PingPayload = { timestamp: Date.now() };
        const socket = io.sockets.sockets.get(socketId);
        if (socket) {
          // Check JWT expiration before sending ping
          const exp = (socket.data as any).tokenExp as number | undefined;
          if (exp && exp < Date.now()) {
            // Token has expired – notify client and disconnect
            logger.warn(`[Socket] JWT expired for socket id=${socketId}`);
            socket.emit('auth_expired');
            socket.disconnect(true);
          } else {
            socket.emit('ping', pingPayload);
          }
        }
      }
    }

    const result: HealthCheckResult = {
      checkedAt,
      totalConnections: this.connections.size + staleConnectionsEvicted,
      staleConnectionsEvicted,
      activeConnections: this.connections.size,
    };

    logger.debug(
      `[Socket] Health-check tick — active=${result.activeConnections} ` +
        `evicted=${result.staleConnectionsEvicted}`,
    );

    return result;
  }

  /**
   * Return the current number of tracked connections.
   */
  public getConnectionCount(): number {
    return this.connections.size;
  }

  /**
   * Clear the in-memory connection registry. Called after all sockets have
   * been forcibly disconnected during graceful shutdown.
   */
  public clearConnections(): void {
    this.connections.clear();
  }

  /**
   * Return a read-only snapshot of all active connections (for admin/debug
   * endpoints — never expose in public-facing routes).
   */
  public getConnections(): ReadonlyMap<string, SocketConnectionMeta> {
    return this.connections;
  }

  /**
   * Update the stored JWT expiration for an active connection after the
   * client refreshed its token.
   *
   * @param socketId - Target socket id.
   * @param tokenExp - New expiration timestamp (ms since epoch).
   * @returns         True when the connection is still tracked and updated.
   */
  public updateTokenExpiration(socketId: string, tokenExp: number): boolean {
    const meta = this.connections.get(socketId);
    if (!meta) {
      return false;
    }
    meta.tokenExp = tokenExp;
    return true;
  }

  /**
   * Validate the JWT token stored on a socket's data against the database.
   *
   * Returns true if:
   *   - The socket has no token/userId (unauthenticated, skip validation).
   *   - The token is cryptographically valid, not expired, and references
   *     an existing user whose account is active (not suspended/banned).
   *
   * Returns false if the token is missing, malformed, expired, or references
   * an inactive/non-existent user.
   *
   * @param socket - The socket whose token should be validated.
   * @returns       True if the token is valid (or absent), false otherwise.
   */
  public async validateSocketToken(socket: TypedSocket): Promise<boolean> {
    const token = socket.data.token;
    const userId = socket.data.userId;

    if (!token || !userId) {
      return true;
    }

    try {
      const decoded = authService.verifyToken(token);
      const user = await authService.getUserById(decoded.userId);

      if (!user) {
        logger.warn(`[Socket] Token validation failed — user not found for userId=${userId}`);
        return false;
      }

      if (user.status === 'suspended' || user.status === 'banned') {
        logger.warn(
          `[Socket] Token validation failed — account ${user.status} for userId=${userId}`,
        );
        return false;
      }

      return true;
    } catch (error) {
      logger.warn(
        `[Socket] Token validation failed for userId=${userId}: ${
          error instanceof Error ? error.message : error
        }`,
      );
      return false;
    }
  }
}

/** Singleton instance shared across the application. */
export const socketService = new SocketService();
