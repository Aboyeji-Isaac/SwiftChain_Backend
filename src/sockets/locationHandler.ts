import { Server as SocketIOServer } from 'socket.io';
import authService from '../services/authService';
import logger from '../config/logger';
import { locationService, deliveryRoom } from './location.service';
import { socketService } from './socket.service';
import socketMetricsService from '../services/socketMetricsService';
import {
  DriverLocationUpdatePayload,
  TypedSocket,
  ServerToClientEvents,
  ClientToServerEvents,
  InterServerEvents,
  SocketData,
  AuthExpiredPayload,
  AuthRefreshPayload,
  AuthRefreshAckPayload,
} from './socket.types';
import env from '../config/env';

/**
 * Typed Socket.IO server alias.
 */
type TypedServer = SocketIOServer<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

/**
 * Register the real-time location broadcast event handlers on a connected socket.
 *
 * Responsibilities (controller layer):
 *   - Guard: reject unauthenticated drivers before processing.
 *   - Listen for `driver_location_update` from the driver.
 *   - Delegate to LocationService for persistence + broadcast.
 *   - Emit `location_update_ack` back to the driver.
 *   - Handle `subscribe_delivery` / `unsubscribe_delivery` to manage
 *     delivery room membership for tracking clients (dispatchers, customers).
 *
 * @param io     - The Socket.IO server instance (needed by the service to broadcast).
 * @param socket - The connected socket to register handlers on.
 */
export function registerLocationHandler(io: TypedServer, socket: TypedSocket): void {
  // ── driver_location_update ───────────────────────────────────────────────
  socket.on('driver_location_update', async (payload: DriverLocationUpdatePayload) => {
    const driverId = socket.data.userId;
    const startTime = Date.now();

    // Auth guard
    if (!driverId) {
      logger.warn(
        `[LocationHandler] Unauthenticated driver_location_update — ` + `socketId=${socket.id}`,
      );
      socket.emit('location_update_ack', {
        success: false,
        error: 'Authentication required',
      });
      return;
    }

    // Payload guard
    if (!payload || typeof payload !== 'object') {
      logger.warn(
        `[LocationHandler] Malformed payload from driverId=${driverId} ` + `socketId=${socket.id}`,
      );
      socket.emit('location_update_ack', {
        success: false,
        error: 'Malformed payload',
      });
      return;
    }

    logger.debug(
      `[LocationHandler] driver_location_update — driverId=${driverId} ` +
        `deliveryId=${payload.deliveryId} socketId=${socket.id}`,
    );

    try {
      const ack = await locationService.processLiveUpdate(io, driverId, payload);

      // Record message latency in metrics
      const latencyMs = Date.now() - startTime;
      socketMetricsService.recordMessageLatency(latencyMs);

      socket.emit('location_update_ack', ack);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unexpected error';
      logger.error(`[LocationHandler] Unexpected error — driverId=${driverId}: ${message}`, {
        stack: err instanceof Error ? err.stack : undefined,
      });

      // Record latency even on error
      const latencyMs = Date.now() - startTime;
      socketMetricsService.recordMessageLatency(latencyMs);

      socket.emit('location_update_ack', { success: false, error: message });
    }
  });

  // ── subscribe_delivery ───────────────────────────────────────────────────
  // Allows any client (dispatcher, customer) to subscribe to a delivery room
  // and receive live `location:update` broadcasts.
  socket.on('join_room', (room: string) => {
    // Delivery room joins are validated here to ensure the room name follows
    // the expected format. Generic room joins (non-delivery) pass through.
    if (room.startsWith('delivery:')) {
      const deliveryId = room.replace('delivery:', '');
      if (!deliveryId) {
        logger.warn(`[LocationHandler] Empty deliveryId in join_room — socketId=${socket.id}`);
        return;
      }
      logger.info(
        `[LocationHandler] Socket subscribed to delivery room — ` +
          `socketId=${socket.id} room="${room}"`,
      );
    }
    // Actual join is handled by connectionHandler's join_room listener;
    // this handler only adds delivery-specific logging/validation.
  });

  // ── Token expiration guard ────────────────────────────────────────────────
  // For authenticated drivers, periodically validate the JWT to detect
  // expiration or account changes (suspension, ban). Emit `auth_expired`
  // and gracefully disconnect if the token is not refreshed.
  setupTokenExpirationCheck(io, socket);
}

/**
 * Periodically validate the JWT token stored on the socket. If the token
 * is found invalid, emit `auth_expired` and disconnect after a grace period
 * unless the client refreshes the token via `auth_refresh`.
 *
 * @param io     - The Socket.IO server instance.
 * @param socket - The connected socket to monitor.
 */
function setupTokenExpirationCheck(io: TypedServer, socket: TypedSocket): void {
  const token = socket.data.token;
  const userId = socket.data.userId;

  if (!token || !userId) {
    return;
  }

  const CHECK_INTERVAL_MS = env.SOCKET_TOKEN_CHECK_INTERVAL_MS;
  const GRACE_PERIOD_MS = env.SOCKET_TOKEN_GRACE_PERIOD_MS;

  let graceTimer: NodeJS.Timeout | null = null;
  let checkInterval: NodeJS.Timeout | null = null;

  const clearGraceTimer = (): void => {
    if (graceTimer) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
  };

  const emitAuthExpired = (): void => {
    logger.warn(`[Socket] Token expired for userId=${userId} socketId=${socket.id}`);

    socket.emit('auth_expired', {
      message: 'Your session has expired. Please refresh your token.',
      gracePeriodMs: GRACE_PERIOD_MS,
    } as AuthExpiredPayload);

    graceTimer = setTimeout(() => {
      if (socket.connected) {
        logger.info(
          `[Socket] Grace period expired — disconnecting userId=${userId} socketId=${socket.id}`,
        );
        socket.disconnect(true);
      }
    }, GRACE_PERIOD_MS);
  };

  const validateToken = async (): Promise<void> => {
    try {
      const isValid = await socketService.validateSocketToken(socket);
      if (!isValid) {
        emitAuthExpired();
      }
    } catch (err) {
      logger.error(
        `[Socket] Token validation error — userId=${userId}: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  };

  socket.on('auth_refresh', async (payload: AuthRefreshPayload) => {
    if (!payload?.token || typeof payload.token !== 'string') {
      socket.emit('auth_refresh_ack', {
        success: false,
        error: 'Invalid payload',
      } as AuthRefreshAckPayload);
      return;
    }

    try {
      const decoded = authService.verifyToken(payload.token);
      const user = await authService.getUserById(decoded.userId);

      if (!user || user.status === 'suspended' || user.status === 'banned') {
        socket.emit('auth_refresh_ack', {
          success: false,
          error: 'Invalid or inactive token',
        } as AuthRefreshAckPayload);
        return;
      }

      socket.data.token = payload.token;
      socket.data.userId = decoded.userId;

      clearGraceTimer();

      socket.emit('auth_refresh_ack', { success: true } as AuthRefreshAckPayload);
      logger.info(`[Socket] Token refreshed for userId=${decoded.userId} socketId=${socket.id}`);
    } catch (err) {
      socket.emit('auth_refresh_ack', {
        success: false,
        error: 'Invalid token',
      } as AuthRefreshAckPayload);
    }
  });

  socket.on('disconnect', () => {
    clearGraceTimer();
    if (checkInterval) {
      clearInterval(checkInterval);
      checkInterval = null;
    }
  });

  setTimeout(() => {
    validateToken();
    checkInterval = setInterval(validateToken, CHECK_INTERVAL_MS);
  }, 5000);
}

/**
 * Helper exposed for use in tests and other services to build delivery
 * room names consistently.
 *
 * @param deliveryId - MongoDB ObjectId string of the delivery.
 * @returns            The canonical room name, e.g. "delivery:abc123".
 */
export { deliveryRoom };
