import { Types } from 'mongoose';
import ChatMessage, { IChatMessage } from '../models/ChatMessage';
import { BaseRepository } from './BaseRepository';

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

  /** A page of a delivery's chat history, newest first. */
  async findByDelivery(deliveryId: string, skip: number, limit: number): Promise<IChatMessage[]> {
    return ChatMessage.find({ delivery: new Types.ObjectId(deliveryId) })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean<IChatMessage[]>()
      .exec();
  }

  async countByDelivery(deliveryId: string): Promise<number> {
    return ChatMessage.countDocuments({ delivery: new Types.ObjectId(deliveryId) }).exec();
  }

  /** Record `userId` as having read the given messages of a delivery. */
  async markRead(deliveryId: string, messageIds: string[], userId: string): Promise<number> {
    const result = await ChatMessage.updateMany(
      {
        _id: { $in: messageIds.map((id) => new Types.ObjectId(id)) },
        delivery: new Types.ObjectId(deliveryId),
      },
      { $addToSet: { readBy: userId } },
    ).exec();
    return result.modifiedCount;
  }
}

export const chatMessageRepository = new ChatMessageRepository();
