import { Namespace, Socket } from 'socket.io';
import socketService from './socketService';
import logger from '../config/logger';

/**
 * Wire a connected socket to its handlers.
 *
 * This layer stays deliberately thin: it registers listeners and forwards to
 * the service, which owns validation, persistence and client error responses.
 * Keeping the two apart is what allows the chat logic to be tested without a
 * running Socket.IO server.
 */
const registerSocketHandlers = (socket: Socket, nsp: Namespace): void => {
  logger.info(`Socket connected: ${socket.id} to namespace ${nsp.name}`);

  void socketService.handleConnection(socket, nsp);

  socket.on('message', (payload) => {
    // The service reports failures to the originating socket itself, so no
    // rejection can escape here.
    void socketService.handleIncomingMessage(nsp, payload, socket);
  });

  socket.on('disconnect', (reason) => {
    logger.info(`Socket disconnected: ${socket.id} reason: ${reason}`);
  });

  socket.on('error', (err) => {
    logger.error(`Socket error on ${socket.id}:`, err);
  });
};

export default registerSocketHandlers;
