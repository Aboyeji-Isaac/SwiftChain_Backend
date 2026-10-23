import { Types } from 'mongoose';
import { StatusCodes } from 'http-status-codes';
import AppError from '../utils/AppError';
import { IChatMessage } from '../models/ChatMessage';
import { IDelivery } from '../models/Delivery';
import { UserRole } from '../interfaces/IUser';
import {
  ChatMessageRepository,
  chatMessageRepository,
} from '../repositories/ChatMessageRepository';
import { DeliveryRepository, deliveryRepository } from '../repositories/DeliveryRepository';
import { Page } from '../repositories/types';

export class DeliveryChatService {
  constructor(
    private readonly chatRepo: ChatMessageRepository = chatMessageRepository,
    private readonly deliveryRepo: DeliveryRepository = deliveryRepository,
  ) {}

  /**
   * Asserts that a delivery exists and that the requesting user is a valid participant.
   * Participants include: sender, recipient, driver, creator (userId), or admin.
   */
  async assertParticipant(
    deliveryId: string,
    userId: string,
    userRole?: string,
  ): Promise<IDelivery> {
    if (!Types.ObjectId.isValid(deliveryId)) {
      throw new AppError('Invalid delivery ID.', StatusCodes.BAD_REQUEST);
    }

    const delivery = await this.deliveryRepo.findById(deliveryId);
    if (!delivery) {
      throw new AppError('Delivery not found.', StatusCodes.NOT_FOUND);
    }

    if (userRole === UserRole.ADMIN) {
      return delivery;
    }

    const isParticipant =
      (delivery.sender && String(delivery.sender) === userId) ||
      (delivery.recipient && String(delivery.recipient) === userId) ||
      (delivery.driverId && String(delivery.driverId) === userId) ||
      (delivery.userId && String(delivery.userId) === userId);

    if (!isParticipant) {
      throw new AppError(
        'Access denied: You are not a participant in this delivery chat.',
        StatusCodes.FORBIDDEN,
      );
    }

    return delivery;
  }

  /**
   * Get paginated chat history for a delivery.
   */
  async getDeliveryMessages(
    deliveryId: string,
    userId: string,
    userRole: string | undefined,
    page: number = 1,
    limit: number = 20,
  ): Promise<Page<IChatMessage>> {
    await this.assertParticipant(deliveryId, userId, userRole);
    return this.chatRepo.findDeliveryMessages(deliveryId, page, limit);
  }

  /**
   * Get the unread chat messages count for the requesting user on a delivery.
   */
  async getUnreadCount(
    deliveryId: string,
    userId: string,
    userRole: string | undefined,
  ): Promise<number> {
    await this.assertParticipant(deliveryId, userId, userRole);
    return this.chatRepo.countUnreadForUser(deliveryId, userId);
  }

  /**
   * Mark all unread chat messages for this delivery as read by the requesting user.
   */
  async markMessagesAsRead(
    deliveryId: string,
    userId: string,
    userRole: string | undefined,
  ): Promise<{ modifiedCount: number }> {
    await this.assertParticipant(deliveryId, userId, userRole);
    const modifiedCount = await this.chatRepo.markDeliveryMessagesAsRead(deliveryId, userId);
    return { modifiedCount };
  }
}

export const deliveryChatService = new DeliveryChatService();
export default deliveryChatService;
