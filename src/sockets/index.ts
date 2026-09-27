import { Server, Socket } from 'socket.io';
import { Server as HttpServer } from 'http';
import env from '../config/env';
import registerSocketHandlers from './socketController';
import logger from '../config/logger';
import socketAuth from '../middlewares/socketAuth';

export const initSocket = (httpServer: HttpServer): Server => {
  const io = new Server(httpServer, {
    path: '/socket.io',
    cors: {
      origin: env.CORS_ORIGIN,
      methods: ['GET', 'POST'],
    },
  });

  const nsp = io.of('/api/v1/realtime');

  // Attach authentication middleware to namespace
  nsp.use((socket, next) => socketAuth(socket as Socket, next as (err?: Error) => void));

  nsp.on('connection', (socket) => {
    registerSocketHandlers(socket, nsp);
  });

  logger.info('✅ Socket.io initialized on namespace /api/v1/realtime');

  return io;
};

export default initSocket;
