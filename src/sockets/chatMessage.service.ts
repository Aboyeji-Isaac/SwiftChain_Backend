import { IChatMessage } from '../models/ChatMessage';
import { isEnabled } from '../config/flags';
import {
  ChatMessageRepository,
  chatMessageRepository,
} from '../repositories/ChatMessageRepository';

/** Number of messages replayed to a client when it connects. */
export const RECENT_MESSAGE_LIMIT = 10;

/** Maximum length of a message content in characters. */
export const MAX_MESSAGE_LENGTH = 2000;

/** An incoming message payload, before validation. */
export interface IncomingChatMessage {
  deliveryId?: unknown;
  content?: unknown;
  sender?: unknown;
  recipients?: unknown;
}

/** A validated, persistable message. */
export interface ValidatedChatMessage {
  deliveryId?: Types.ObjectId;
  delivery?: Types.ObjectId;
  content: string;
  sender?: string;
  recipients?: Types.ObjectId[];
  readBy?: IReadReceipt[];
}

/** Raised when an incoming payload fails validation. */
export class InvalidChatMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidChatMessageError';
  }
}

/** Raised when chat is disabled and a caller attempts to persist a message. */
export class ChatFeatureDisabledError extends Error {
  constructor() {
    super('Chat is disabled by feature flag');
    this.name = 'ChatFeatureDisabledError';
  }
}

/**
 * Chat domain logic, decoupled from Socket.IO transport.
 *
 * All validation lives here so that socket payloads are checked before any
 * database write, matching the guarantees Express middleware provides on the
 * HTTP path.
 */
export class ChatMessageService {
  constructor(private readonly messages: ChatMessageRepository = chatMessageRepository) {}

  /**
   * Validate an incoming raw payload.
   *
   * The query returns newest-first to use the descending `createdAt` index;
   * the reversal to reading order happens here rather than in the handler so
   * every caller gets the same ordering.
   */
  async getRecentTranscript(limit: number = RECENT_MESSAGE_LIMIT): Promise<IChatMessage[]> {
    if (!isEnabled('chat')) return [];

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
    if (payload === null || typeof payload !== 'object') {
      throw new InvalidChatMessageError('Payload must be an object');
    }

    if (payload.content === undefined || payload.content === null) {
      throw new InvalidChatMessageError('Message content is required');
    }

    if (typeof payload.content !== 'string') {
      throw new InvalidChatMessageError('Message content is required');
    }

    const content = payload.content.trim();
    if (content.length === 0) {
      throw new InvalidChatMessageError('Message content cannot be empty');
    }

    if (content.length > MAX_MESSAGE_LENGTH) {
      throw new InvalidChatMessageError(
        `Message content cannot exceed ${MAX_MESSAGE_LENGTH} characters`,
      );
    }

    if (payload.sender !== undefined && typeof payload.sender !== 'string') {
      throw new InvalidChatMessageError('Sender must be a string');
    }

    const sender = typeof payload.sender === 'string' ? payload.sender.trim() : undefined;

    let deliveryId: Types.ObjectId | undefined;
    if (payload.deliveryId !== undefined) {
      const dIdStr = String(payload.deliveryId).trim();
      if (!Types.ObjectId.isValid(dIdStr)) {
        throw new InvalidChatMessageError('deliveryId must be a valid ObjectId');
      }
      deliveryId = new Types.ObjectId(dIdStr);
    }

    let recipients: Types.ObjectId[] | undefined;
    if (payload.recipients !== undefined) {
      if (!Array.isArray(payload.recipients)) {
        throw new InvalidChatMessageError('recipients must be an array of ObjectIds');
      }
      recipients = payload.recipients.map((r) => {
        const str = String(r).trim();
        if (!Types.ObjectId.isValid(str)) {
          throw new InvalidChatMessageError('Each recipient must be a valid ObjectId');
        }
        return new Types.ObjectId(str);
      });
    }

    return {
      content,
      ...(sender ? { sender } : {}),
      ...(deliveryId ? { deliveryId, delivery: deliveryId } : {}),
      ...(recipients ? { recipients } : {}),
    };
  }

  /**
   * Validate and persist an incoming message.
   *
   * @throws {InvalidChatMessageError} If the payload is unusable.
   */
  async createMessage(payload: IncomingChatMessage): Promise<IChatMessage> {
    if (!isEnabled('chat')) throw new ChatFeatureDisabledError();

    const validated = this.validate(payload);

    let recipients: Types.ObjectId[] = validated.recipients ?? [];
    if (validated.deliveryId && recipients.length === 0) {
      try {
        const delivery = await Delivery.findById(validated.deliveryId);
        if (delivery) {
          const candidateIds = [
            delivery.sender,
            delivery.recipient,
            delivery.driverId,
            delivery.userId,
          ].filter(Boolean);

          const senderStr = validated.sender ? String(validated.sender) : '';
          const uniqueIds = Array.from(
            new Set(
              candidateIds
                .map((id) => String(id))
                .filter((id) => id !== senderStr && Types.ObjectId.isValid(id)),
            ),
          );

          recipients = uniqueIds.map((id) => new Types.ObjectId(id));
        }
      } catch {
        // Fallback to empty if delivery cannot be queried
      }
    }

    const readBy: IReadReceipt[] = validated.sender
      ? [
          {
            userId: Types.ObjectId.isValid(validated.sender)
              ? new Types.ObjectId(validated.sender)
              : validated.sender,
            readAt: new Date(),
          },
        ]
      : [];

    return this.messages.create({
      ...validated,
      recipients,
      readBy,
    } as Partial<IChatMessage>);
  }

  /**
   * The initial transcript shown to a newly connected client: the most
   * recent messages, returned in chronological order (oldest first).
   *
   * @param limit - How many messages to replay. Defaults to RECENT_MESSAGE_LIMIT.
   */
  async getRecentTranscript(limit: number = RECENT_MESSAGE_LIMIT): Promise<IChatMessage[]> {
    const messages = await this.messages.findRecent(limit);
    return messages.reverse();
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

    const dIdObj = new Types.ObjectId(deliveryId);

    return this.messages.create({
      content,
      sender: senderId,
      senderRole: user?.role,
      delivery: dIdObj,
      deliveryId: dIdObj,
      readBy: [{ userId: senderId, readAt: new Date() }],
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
export default chatMessageService;
