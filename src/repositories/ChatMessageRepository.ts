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
   * The most recent messages across the whole application, newest first.
   *
   * Used on socket connection to replay the transcript. Bounded by `limit`
   * so a busy room cannot flood memory.
   *
   * @param limit - Maximum number of messages to return.
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

  /** A page of a delivery's chat history, newest first. */
  async findByDelivery(deliveryId: string, skip: number, limit: number): Promise<IChatMessage[]> {
    const filter = this.buildDeliveryFilter(deliveryId);
    return ChatMessage.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean<IChatMessage[]>()
      .exec();
  }

  async countByDelivery(deliveryId: string): Promise<number> {
    const filter = this.buildDeliveryFilter(deliveryId);
    return ChatMessage.countDocuments(filter).exec();
  }

  /** Record `userId` as having read the given messages of a delivery. */
  async markRead(deliveryId: string, messageIds: string[], userId: string): Promise<number> {
    const userObjId = Types.ObjectId.isValid(userId) ? new Types.ObjectId(userId) : userId;
    const filter = {
      _id: {
        $in: messageIds.map((id) => (Types.ObjectId.isValid(id) ? new Types.ObjectId(id) : id)),
      },
      ...this.buildDeliveryFilter(deliveryId),
      'readBy.userId': { $ne: userObjId },
    };
    const result = await ChatMessage.updateMany(filter, {
      $push: {
        readBy: {
          userId: userObjId,
          readAt: new Date(),
        },
      },
    }).exec();
    return result.modifiedCount;
  }

  private buildDeliveryFilter(deliveryId: string): FilterQuery<IChatMessage> {
    const idObj = Types.ObjectId.isValid(deliveryId) ? new Types.ObjectId(deliveryId) : deliveryId;
    return {
      $or: [{ deliveryId: idObj }, { delivery: idObj }],
    };
  }
}

export const chatMessageRepository = new ChatMessageRepository();
export default chatMessageRepository;
