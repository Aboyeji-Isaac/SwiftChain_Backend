import { FilterQuery, Types } from 'mongoose';
import ChatMessage, { IChatMessage } from '../models/ChatMessage';
import { BaseRepository } from './BaseRepository';
import { Page } from './types';

/** Persistence gateway for realtime chat messages. */
export class ChatMessageRepository extends BaseRepository<IChatMessage> {
  constructor() {
    super(ChatMessage);
  }

  /**
   * The most recent messages, newest first.
   *
   * Callers that render a transcript reverse the result to get chronological
   * order; the query itself stays newest-first so it can use the descending
   * `createdAt` index.
   */
  async findRecent(limit: number): Promise<IChatMessage[]> {
    return this.find({}, { sort: { createdAt: -1 }, limit, lean: true });
  }

  /**
   * Find paginated chat messages for a specific delivery, newest first.
   */
  async findDeliveryMessages(
    deliveryId: string,
    page: number = 1,
    limit: number = 20,
  ): Promise<Page<IChatMessage>> {
    const filter = this.buildDeliveryFilter(deliveryId);
    return this.paginate(filter, page, limit, {
      sort: { createdAt: -1 },
      lean: true,
    });
  }

  /**
   * Count the number of unread messages in a delivery for a given user.
   * A message is unread if:
   * 1. It belongs to the delivery.
   * 2. It was sent by someone other than the user.
   * 3. The user's ID does not appear in the `readBy` array.
   */
  async countUnreadForUser(deliveryId: string, userId: string): Promise<number> {
    const userMatches = Types.ObjectId.isValid(userId)
      ? [userId, new Types.ObjectId(userId)]
      : [userId];

    const filter: FilterQuery<IChatMessage> = {
      ...this.buildDeliveryFilter(deliveryId),
      sender: { $nin: userMatches },
      'readBy.userId': { $nin: userMatches },
    };

    return this.count(filter);
  }

  /**
   * Mark all unread messages in a delivery as read by the user.
   * Appends `{ userId, readAt }` to the `readBy` array.
   *
   * @returns Number of messages updated.
   */
  async markDeliveryMessagesAsRead(deliveryId: string, userId: string): Promise<number> {
    const userMatches = Types.ObjectId.isValid(userId)
      ? [userId, new Types.ObjectId(userId)]
      : [userId];

    const userObjId = Types.ObjectId.isValid(userId) ? new Types.ObjectId(userId) : userId;

    const filter: FilterQuery<IChatMessage> = {
      ...this.buildDeliveryFilter(deliveryId),
      sender: { $nin: userMatches },
      'readBy.userId': { $nin: userMatches },
    };

    const result = await this.model.updateMany(filter, {
      $push: {
        readBy: {
          userId: userObjId,
          readAt: new Date(),
        },
      },
    });

    return result.modifiedCount;
  }

  private buildDeliveryFilter(deliveryId: string): FilterQuery<IChatMessage> {
    if (Types.ObjectId.isValid(deliveryId)) {
      return { deliveryId: new Types.ObjectId(deliveryId) };
    }
    return { deliveryId };
  }
}

export const chatMessageRepository = new ChatMessageRepository();
