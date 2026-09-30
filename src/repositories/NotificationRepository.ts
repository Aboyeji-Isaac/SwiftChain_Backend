import { Types, FilterQuery, SortOrder } from 'mongoose';
import Notification, { INotification } from '../models/Notification';
import { BaseRepository } from './BaseRepository';
import { Page } from './types';

/**
 * Persistence gateway for the notification audit log.
 *
 * Every send attempt is recorded — including suppressed and failed ones — so
 * "why didn't I get notified?" is answerable from the database rather than
 * from application logs.
 */
export class NotificationRepository extends BaseRepository<INotification> {
  constructor() {
    super(Notification);
  }

  /** One page of a user's notification history, newest first. */
  async listForUser(
    _userId: string | Types.ObjectId,
    filter: FilterQuery<INotification>,
    page: number,
    limit: number,
    sort: Record<string, SortOrder> = { createdAt: -1 },
  ): Promise<Page<INotification>> {
    return this.paginate(filter, page, limit, { sort });
  }

  /** Every notification recorded for a delivery, newest first. */
  async listForDelivery(deliveryId: string | Types.ObjectId): Promise<INotification[]> {
    if (typeof deliveryId === 'string' && !this.isValidId(deliveryId)) return [];
    return this.find({ delivery: deliveryId }, { sort: { createdAt: -1 } });
  }
}

export const notificationRepository = new NotificationRepository();
