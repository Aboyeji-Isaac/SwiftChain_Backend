import { Types } from 'mongoose';
import { IChatMessage, IReadReceipt } from '../models/ChatMessage';
import {
  ChatMessageRepository,
  chatMessageRepository,
} from '../repositories/ChatMessageRepository';
import Delivery from '../models/Delivery';

/** Number of messages replayed to a client when it connects. */
export const RECENT_MESSAGE_LIMIT = 10;

/** Maximum accepted length of a single chat message. */
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
      ...(deliveryId ? { deliveryId } : {}),
      ...(recipients ? { recipients } : {}),
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
}

export const chatMessageService = new ChatMessageService();
