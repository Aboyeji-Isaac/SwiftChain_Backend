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
}

export const chatMessageRepository = new ChatMessageRepository();
