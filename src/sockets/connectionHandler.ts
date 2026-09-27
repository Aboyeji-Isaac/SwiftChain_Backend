import { Server as SocketIOServer } from 'socket.io';
import { Server as HttpServer } from 'http';
import env from '../config/env';
import logger from '../config/logger';
import { socketService } from './socket.service';
import { registerSyncHandler } from './syncHandler';
import { registerLocationHandler } from './locationHandler';
import { messageQueueService } from './messageQueue';
import {
  PongPayload,
  ServerToClientEvents,
  ClientToServerEvents,
  InterServerEvents,
  SocketData,
  TypedSocket,
} from './socket.types';

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
    // Optionally extract userId from auth handshake data
    const userId = extractUserId(socket);

    // Store userId on the socket data for easy access later
    socket.data.connectedAt = Date.now();
    socket.data.userId = userId;

    // Register the connection in the service layer
    socketService.registerConnection(socket, userId);

    // ── offline sync handler ─────────────────────────────────────────────────
    registerSyncHandler(socket);

    // ── real-time location broadcast handler ─────────────────────────────────
    registerLocationHandler(io, socket);

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
      socketService.handleDisconnect(socket, reason);
    });

    // ── error handler ────────────────────────────────────────────────────────
    socket.on('error', (err: Error) => {
      logger.error(`[Socket] Error on id=${socket.id}: ${err.message}`, { stack: err.stack });
    });
  });

  // ─── Application-level health checks ──────────────────────────────────────
  socketService.startHealthChecks(io);

  logger.info('[Socket] Socket.IO server initialised and health-check loop started');

  return io;
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
 *   `socket = io(url, { auth: { token: 'Bearer <jwt>' } })`
 *
 * This is intentionally lightweight — full JWT verification should be
 * done in a dedicated auth middleware if required.
 *
 * @param socket - The connecting socket.
 * @returns        The userId string, or undefined if absent.
 */
function extractUserId(socket: TypedSocket): string | undefined {
  const auth = socket.handshake.auth as Record<string, unknown>;

  if (typeof auth?.userId === 'string' && auth.userId.trim()) {
    return auth.userId.trim();
  }

  // Fallback: check query params (useful for testing with Postman)
  const queryUserId = socket.handshake.query?.userId;
  if (typeof queryUserId === 'string' && queryUserId.trim()) {
    return queryUserId.trim();
  }

  return undefined;
}
