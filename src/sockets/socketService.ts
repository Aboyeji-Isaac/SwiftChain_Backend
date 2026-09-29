import { Namespace, Socket } from 'socket.io';
import { IChatMessage } from '../models/ChatMessage';
import logger from '../config/logger';
import {
  ChatMessageService,
  IncomingChatMessage,
  InvalidChatMessageError,
  chatMessageService,
} from './chatMessage.service';

/**
 * Transport adapter for chat sockets.
 *
 * Business logic lives in {@link ChatMessageService}; this class only
 * translates between that service and Socket.IO — emitting results, turning
 * validation failures into client-visible errors, and logging.
 *
 * The split keeps the logic unit-testable without a WebSocket server, and
 * keeps transport concerns out of the service.
 */
export class SocketService {
  constructor(private readonly chat: ChatMessageService = chatMessageService) {}

  /** Recent messages in reading order. Retained for existing callers. */
  public async getRecentMessages(limit?: number): Promise<IChatMessage[]> {
    return this.chat.getRecentTranscript(limit);
  }

  /**
   * Replay the recent transcript to a client that has just connected.
   *
   * A read failure is reported to that client alone and never rethrown — one
   * client's failed backlog must not tear down the connection handler.
   */
  public async handleConnection(socket: Socket, _nsp: Namespace): Promise<void> {
    try {
      const recent = await this.chat.getRecentTranscript();
      socket.emit('recentMessages', recent);
    } catch (error) {
      logger.error('[SocketService] Failed to load recent messages', error);
      socket.emit('error', { message: 'Failed to load recent messages' });
    }
  }

  /**
   * Persist an incoming message and broadcast it to the namespace.
   *
   * Invalid payloads are answered on the originating socket when one is
   * supplied, so a client learns why its message was rejected instead of
   * failing silently.
   *
   * @param socket - Originating socket, used to deliver rejection notices.
   */
  public async handleIncomingMessage(
    nsp: Namespace,
    payload: IncomingChatMessage,
    socket?: Socket,
  ): Promise<void> {
    try {
      const message = await this.chat.createMessage(payload);
      nsp.emit('message', message);
    } catch (error) {
      if (error instanceof InvalidChatMessageError) {
        logger.warn(`[SocketService] Rejected invalid message: ${error.message}`);
        socket?.emit('error', { message: error.message });
        return;
      }

      logger.error('[SocketService] Failed to save message', error);
      socket?.emit('error', { message: 'Failed to send message' });
    }
  }
}

export default new SocketService();
