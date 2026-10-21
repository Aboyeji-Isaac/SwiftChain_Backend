import { Types } from 'mongoose';
import { IChatMessage } from '../models/ChatMessage';
import Delivery from '../models/Delivery';
import User from '../models/User';
import { UserRole } from '../interfaces/IUser';
import {
  ChatMessageRepository,
  chatMessageRepository,
} from '../repositories/ChatMessageRepository';

/** Number of messages replayed to a client when it connects. */
export const RECENT_MESSAGE_LIMIT = 10;

/** Maximum accepted length of a single chat message. */
export const MAX_MESSAGE_LENGTH = 2000;

/** An incoming message payload, before validation. */
export interface IncomingChatMessage {
  content?: unknown;
  sender?: unknown;
}

/** A validated, persistable message. */
export interface ValidatedChatMessage {
  content: string;
  sender?: string;
}

/** Raised when an incoming payload fails validation. */
export class InvalidChatMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidChatMessageError';
  }
}

/**
 * Chat business logic, isolated from Socket.IO.
 *
 * Nothing here touches a socket, a namespace, or an event name: the class
 * takes plain values and returns plain values, which is what makes it
 * testable without standing up a WebSocket server. The socket handler is
 * responsible for transport concerns (emitting, error responses, logging).
 */
export class ChatMessageService {
  constructor(private readonly messages: ChatMessageRepository = chatMessageRepository) {}

  /**
   * The transcript replayed to a newly connected client, oldest first.
   *
   * The query returns newest-first to use the descending `createdAt` index;
   * the reversal to reading order happens here rather than in the handler so
   * every caller gets the same ordering.
   */
  async getRecentTranscript(limit: number = RECENT_MESSAGE_LIMIT): Promise<IChatMessage[]> {
    const recent = await this.messages.findRecent(limit);
    return recent.reverse();
  }

  /**
   * Validate an untrusted payload from a client.
   *
   * Socket payloads bypass Express middleware entirely, so this is the only
   * validation boundary for realtime input — it must not assume any prior
   * checking.
   *
   * @throws {InvalidChatMessageError} If the payload is unusable.
   */
  validate(payload: IncomingChatMessage): ValidatedChatMessage {
    if (!payload || typeof payload !== 'object') {
      throw new InvalidChatMessageError('Message payload must be an object');
    }

    if (typeof payload.content !== 'string') {
      throw new InvalidChatMessageError('Message content is required');
    }

    const content = payload.content.trim();

    if (content === '') {
      throw new InvalidChatMessageError('Message content cannot be empty');
    }

    if (content.length > MAX_MESSAGE_LENGTH) {
      throw new InvalidChatMessageError(
        `Message content cannot exceed ${MAX_MESSAGE_LENGTH} characters`,
      );
    }

    if (payload.sender !== undefined && typeof payload.sender !== 'string') {
      throw new InvalidChatMessageError('Message sender must be a string');
    }

    const sender = typeof payload.sender === 'string' ? payload.sender.trim() : undefined;

    return {
      content,
      ...(sender ? { sender } : {}),
    };
  }

  /**
   * Validate and persist an incoming message.
   *
   * @returns The stored message, ready to broadcast.
   * @throws {InvalidChatMessageError} If the payload is unusable.
   */
  async createMessage(payload: IncomingChatMessage): Promise<IChatMessage> {
    const validated = this.validate(payload);
    return this.messages.create(validated as Partial<IChatMessage>);
  }

  /**
   * Whether `userId` may participate in the chat of `deliveryId`: the sender,
   * recipient, assigned driver, or staff (admin).
   */
  async canAccessDelivery(userId: string | undefined, deliveryId: string): Promise<boolean> {
    if (!userId || !Types.ObjectId.isValid(deliveryId) || !Types.ObjectId.isValid(userId)) {
      return false;
    }

    const [delivery, user] = await Promise.all([
      Delivery.findById(deliveryId).select('sender recipient driverId userId').lean(),
      User.findById(userId).select('role').lean(),
    ]);
    if (!delivery || !user) return false;
    if (user.role === UserRole.ADMIN) return true;

    const participants = [delivery.sender, delivery.recipient, delivery.driverId, delivery.userId]
      .filter((id) => id !== undefined && id !== null)
      .map(String);
    return participants.includes(userId);
  }

  /**
   * Validate and persist a message scoped to a delivery. The sender is always
   * the authenticated user, never a client-supplied value.
   *
   * @throws {InvalidChatMessageError} If the payload is unusable.
   */
  async createDeliveryMessage(
    deliveryId: string,
    senderId: string,
    payload: IncomingChatMessage,
  ): Promise<IChatMessage> {
    if (!Types.ObjectId.isValid(deliveryId)) {
      throw new InvalidChatMessageError('Invalid deliveryId');
    }
    const { content } = this.validate({ content: payload?.content });
    const user = await User.findById(senderId).select('role').lean();

    return this.messages.create({
      content,
      sender: senderId,
      senderRole: user?.role,
      delivery: new Types.ObjectId(deliveryId),
      readBy: [senderId],
    } as Partial<IChatMessage>);
  }

  /** Paginated chat history for a delivery, oldest first within the page. */
  async getDeliveryHistory(
    deliveryId: string,
    page = 1,
    limit = DEFAULT_HISTORY_LIMIT,
  ): Promise<DeliveryChatHistory> {
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(MAX_HISTORY_LIMIT, Math.max(1, limit));
    const [messages, total] = await Promise.all([
      this.messages.findByDelivery(deliveryId, (safePage - 1) * safeLimit, safeLimit),
      this.messages.countByDelivery(deliveryId),
    ]);

    return {
      messages: messages.reverse(),
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit),
    };
  }

  /** Mark messages in a delivery chat as read by `userId`. */
  async markRead(deliveryId: string, messageIds: unknown, userId: string): Promise<string[]> {
    if (!Array.isArray(messageIds)) {
      throw new InvalidChatMessageError('messageIds must be an array');
    }
    const ids = messageIds.filter(
      (id): id is string => typeof id === 'string' && Types.ObjectId.isValid(id),
    );
    if (ids.length > 0) {
      await this.messages.markRead(deliveryId, ids, userId);
    }
    return ids;
  }
}

/** Default and maximum page sizes for delivery chat history. */
export const DEFAULT_HISTORY_LIMIT = 50;
export const MAX_HISTORY_LIMIT = 100;

export interface DeliveryChatHistory {
  messages: IChatMessage[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export const chatMessageService = new ChatMessageService();
