import { Server, Socket, Namespace } from 'socket.io';
import { Server as HttpServer } from 'http';
import env from '../config/env';
import registerSocketHandlers from './socketController';
import logger from '../config/logger';
import socketAuth from '../middlewares/socketAuth';
import env from '../config/env';

let realtimeNsp: Namespace | null = null;

export const initSocket = (httpServer: HttpServer): Server => {
  const io = new Server(httpServer, {
    path: '/socket.io',
    cors: {
      origin: env.CORS_ORIGIN,
      methods: ['GET', 'POST'],
    },
  });

  const nsp = io.of('/api/v1/realtime');

  // Store namespace for external use
  realtimeNsp = nsp;

  // Attach authentication middleware to namespace
  nsp.use((socket, next) => socketAuth(socket as Socket, next as (err?: Error) => void));

  nsp.on('connection', (socket) => {
    // Join a room based on user ID if available
    const userId = (socket as any).user?.id;
    if (userId) {
      socket.join(userId);
    }
    registerSocketHandlers(socket, nsp);
  });

  logger.info('✅ Socket.io initialized on namespace /api/v1/realtime');

  return io;
};

/**
 * Emits a delivery_status_updated event to a specific user's connected socket(s).
 * This is intended to be called from the indexer handler when the on-chain
 * delivery_status_updated event is processed.
 */
export const emitDeliveryStatusUpdated = (userId: string, payload: unknown): void => {
  if (!realtimeNsp) {
    logger.warn('Socket.io namespace not initialized yet');
    return;
  }
  realtimeNsp.to(userId).emit('delivery_status_updated', payload);
};

export default initSocket;
