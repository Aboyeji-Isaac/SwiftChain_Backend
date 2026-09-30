import { Server as SocketIOServer } from 'socket.io';
import { Server as HttpServer } from 'http';
import env from '../config/env';
import logger from '../config/logger';
import { socketService } from './socket.service';
import { registerSyncHandler } from './syncHandler';
import { registerLocationHandler } from './locationHandler';
import { messageQueueService } from './messageQueue';
import socketMetricsService from '../services/socketMetricsService';
import {
  PongPayload,
  ServerToClientEvents,
  ClientToServerEvents,
  InterServerEvents,
  SocketData,
  TypedSocket,
  DeliveryStatusUpdatedPayload,
} from './socket.types';
import jwt from 'jsonwebtoken';

/**
 * The live server instance, captured by {@link initializeSocketServer} and
 * cleared by {@link shutdownSocketServer}. Module-level state is safe here:
 * a Node.js process runs one Socket.IO server (see the module doc above).
 */
let liveServer: TypedServer | null = null;

/**
 * Typed Socket.IO server alias used throughout the sockets layer.
 */
export type TypedServer = SocketIOServer<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

/**
 * Create and configure a typed Socket.IO server attached to the given
 * HTTP server.
 *
 * Responsibilities (controller layer):
 *   - Attach Socket.IO to the HTTP server with CORS config.
 *   - Register per-socket event handlers.
 *   - Delegate business logic to SocketService.
 *   - Start the health-check loop.
 *
 * @param httpServer - The Node.js HTTP server returned by `app.listen`.
 * @returns           The configured Socket.IO server instance.
 */
export function initializeSocketServer(httpServer: HttpServer): TypedServer {
  const io: TypedServer = new SocketIOServer(httpServer, {
    cors: {
      origin: env.CORS_ORIGIN,
      methods: ['GET', 'POST'],
      credentials: true,
    },
    // Use Socket.IO's built-in transport-level ping/pong as a fallback
    pingTimeout: env.SOCKET_PING_TIMEOUT_MS,
    pingInterval: env.SOCKET_PING_INTERVAL_MS,
    // Allow only websocket transport in production for efficiency
    transports: env.NODE_ENV === 'production' ? ['websocket'] : ['websocket', 'polling'],
  });

  // ─── Per-connection setup ──────────────────────────────────────────────────
  io.on('connection', (socket: TypedSocket) => {
    // Record connection in metrics
    socketMetricsService.recordConnection();

    // Extract authentication info from handshake
    const { userId, tokenExp } = extractAuthInfo(socket);

    // Store auth data on socket data
    socket.data.connectedAt = Date.now();
    if (userId) socket.data.userId = userId;
    if (tokenExp) (socket.data as any).tokenExp = tokenExp;

    // Register the connection in the service layer with token expiration
    socketService.registerConnection(socket, userId, tokenExp);

    // ── offline sync handler ─────────────────────────────────────────────────
    registerSyncHandler(socket);

    // ── real-time location broadcast handler ─────────────────────────────────
    registerLocationHandler(io, socket);

    // ── token refresh handler ─────────────────────────────────────────────────────
    socket.on('refresh_token', (payload: { token: string }) => {
      const token = payload?.token;
      if (!token) {
        logger.warn(`[Socket] refresh_token missing token – socketId=${socket.id}`);
        socket.emit('auth_expired');
        socket.disconnect(true);
        return;
      }
      try {
        const rawToken = token.startsWith('Bearer ') ? token.slice(7) : token;
        const decoded = jwt.verify(rawToken, env.JWT_SECRET) as { userId?: string; exp?: number };
        const newExp = typeof decoded.exp === 'number' ? decoded.exp * 1000 : undefined;
        if (newExp) {
          (socket.data as any).tokenExp = newExp;
          socketService.updateTokenExpiration(socket.id, newExp);
          logger.info(`[Socket] Token refreshed for socketId=${socket.id}`);
        }
      } catch (err) {
        logger.warn(
          `Token refresh verification failed for socket ${socket.id}: ${(err as Error).message}`,
        );
        socket.emit('auth_expired');
        socket.disconnect(true);
      }
    });

    // ── pong handler ────────────────────────────────────────────────────────
    socket.on('pong', (payload: PongPayload) => {
      socketService.handlePong(socket, payload);
    });

    // ── room join tracking ───────────────────────────────────────────────────
    socket.on('join_room', (room: string) => {
      socket.join(room);
      socketService.trackRoomJoin(socket.id, room);
      logger.info(`[Socket] id=${socket.id} joined room="${room}"`);
    });

    socket.on('message_ack', (messageId: string) => {
      const userId = socket.data.userId;
      if (!userId) {
        logger.warn(`[Socket] Acknowledgement received without userId for socket=${socket.id}`);
        return;
      }

      const removed = messageQueueService.acknowledge(userId, messageId);
      logger.debug(
        removed
          ? `[Socket] Acked queued message messageId=${messageId} userId=${userId}`
          : `[Socket] Ack ignored; messageId=${messageId} not found for userId=${userId}`,
      );
    });

    // ── room leave tracking ──────────────────────────────────────────────────
    socket.on('leave_room', (room: string) => {
      socket.leave(room);
      socketService.trackRoomLeave(socket.id, room);
      logger.info(`[Socket] id=${socket.id} left room="${room}"`);
    });

    // ── disconnect handler ───────────────────────────────────────────────────
    socket.on('disconnect', (reason: string) => {
      // Record disconnection in metrics
      socketMetricsService.recordDisconnection();

      socketService.handleDisconnect(socket, reason);
    });

    // ── error handler ────────────────────────────────────────────────────────
    socket.on('error', (err: Error) => {
      logger.error(`[Socket] Error on id=${socket.id}: ${err.message}`, { stack: err.stack });
    });
  });

  // ─── Application-level health checks ──────────────────────────────────────
  socketService.startHealthChecks(io);

  // Capture the live instance so server-side emitters (indexer, jobs) can
  // broadcast without holding a reference to the HTTP server.
  liveServer = io;

  logger.info('[Socket] Socket.IO server initialised and health-check loop started');

  return io;
}

/**
 * Single live Socket.IO entry point: this module is the ONLY server the
 * process starts (`src/server.ts` → `initializeSocketServer`), so all
 * realtime emits route through here — including server-side pushes from
 * background services such as the escrow indexer below.
 *
 * Broadcast a chain-confirmed delivery status change to the delivery's room
 * (`delivery:<id>`, joined via `join_room`). Safe to call before the server
 * is initialised or after shutdown: it logs and returns instead of throwing,
 * so a socket outage can never fail the indexer's DB write (issue #212).
 *
 * @param deliveryId - Delivery the status change applies to; names the room.
 * @param payload    - Contract id, delivery id and new status to broadcast.
 */
export function emitDeliveryStatusUpdated(
  deliveryId: string,
  payload: DeliveryStatusUpdatedPayload,
): void {
  if (!liveServer) {
    logger.warn(
      `[Socket] delivery_status_updated dropped for delivery=${deliveryId} — Socket.IO server not initialised`,
    );
    return;
  }
  liveServer.to(`delivery:${deliveryId}`).emit('delivery_status_updated', payload);
}

/**
 * Gracefully shut down the Socket.IO server:
 *   - Stop the health-check loop.
 *   - Forcibly disconnect every connected client (drain).
 *   - Clear the in-memory connection registry.
 *   - Close the Socket.IO server itself.
 *
 * @param io - The Socket.IO server to shut down.
 */
export async function shutdownSocketServer(io: TypedServer): Promise<void> {
  socketService.stopHealthChecks();

  // Drop the emit target first so a late in-flight emit logs instead of
  // writing to a closing server.
  liveServer = null;
  const activeBefore = socketService.getConnectionCount();
  logger.info(`[Socket] Draining ${activeBefore} active connection(s)...`);

  // Force-close all client sockets so keep-alive / long-polling transports
  // do not hold the process open after HTTP has stopped accepting work.
  io.disconnectSockets(true);
  socketService.clearConnections();

  return new Promise((resolve, reject) => {
    io.close((err) => {
      if (err) {
        logger.error('[Socket] Error during shutdown:', err);
        return reject(err);
      }
      logger.info('[Socket] Socket.IO server shut down cleanly');
      resolve();
    });
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Extract an authenticated user ID from the socket handshake.
 *
 * Clients should pass their JWT in the `auth` object:
 *   `socket = io(url, { auth: { userId: "..." } })`
 *
 * @param socket - The connecting socket.
 * @returns        The userId string, or undefined if absent.
 */
function extractAuthInfo(socket: TypedSocket): { userId?: string; tokenExp?: number } {
  const auth = socket.handshake.auth as Record<string, unknown>;
  const token = typeof auth?.token === 'string' ? auth.token : undefined;

  if (!token) {
    return {};
  }

  try {
    const rawToken = token.startsWith('Bearer ') ? token.slice(7) : token;
    const decoded = jwt.verify(rawToken, env.JWT_SECRET) as { userId?: string; exp?: number };
    return {
      userId: typeof decoded.userId === 'string' ? decoded.userId : undefined,
      tokenExp: typeof decoded.exp === 'number' ? decoded.exp * 1000 : undefined,
    };
  } catch (err) {
    logger.warn(`JWT verification failed for socket ${socket.id}: ${(err as Error).message}`);
    return {};
  }
}

/**
 * Extract a JWT token from the socket handshake.
 *
 * Clients should pass their token in the `auth` object:
 *   `socket = io(url, { auth: { token: 'Bearer <jwt>' } })`
 *
 * @param socket - The connecting socket.
 * @returns        The raw token string, or undefined if absent.
 */
function _extractToken(socket: TypedSocket): string | undefined {
  const auth = socket.handshake.auth as Record<string, unknown>;

  if (typeof auth?.token === 'string' && auth.token.trim()) {
    return auth.token.trim();
  }

  // Fallback: check query params
  const queryToken = socket.handshake.query?.token;
  if (typeof queryToken === 'string' && queryToken.trim()) {
    return queryToken.trim();
  }

  return undefined;
}
