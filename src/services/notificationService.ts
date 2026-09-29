import httpStatus from 'http-status-codes';
import { Types } from 'mongoose';
import logger from '../config/logger';
import { AppError } from '../utils/AppError';
import { Delivery, DeliveryStatus, IDelivery } from '../models/Delivery';
import {
  IDeviceToken,
  INotificationPreference,
  NotificationChannel,
  NotificationEvent,
} from '../models/NotificationPreference';
import { INotification, NotificationStatus } from '../models/Notification';
import {
  NotificationPreferenceRepository,
  notificationPreferenceRepository as defaultPreferenceRepository,
} from '../repositories/NotificationPreferenceRepository';
import {
  NotificationRepository,
  notificationRepository as defaultNotificationRepository,
} from '../repositories/NotificationRepository';
import { Page } from '../repositories/types';
import { IPushProvider, PushResult } from './push/pushProvider';
import { fcmProvider } from './push/fcmProvider';

/**
 * Maps a delivery status onto the notification event it raises.
 *
 * Statuses absent from this map are internal bookkeeping and never notify —
 * `FUNDED`, for instance, is meaningful to the escrow flow but not to the
 * recipient waiting on a package.
 */
const STATUS_EVENTS: Partial<Record<DeliveryStatus, NotificationEvent>> = {
  [DeliveryStatus.PENDING]: NotificationEvent.DELIVERY_PENDING,
  [DeliveryStatus.ASSIGNED]: NotificationEvent.DELIVERY_ASSIGNED,
  [DeliveryStatus.IN_PROGRESS]: NotificationEvent.DELIVERY_IN_PROGRESS,
  [DeliveryStatus.COMPLETED]: NotificationEvent.DELIVERY_COMPLETED,
  [DeliveryStatus.CANCELLED]: NotificationEvent.DELIVERY_CANCELLED,
};

/** Copy shown in the push notification for each event. */
const EVENT_COPY: Record<NotificationEvent, { title: string; body: (ref: string) => string }> = {
  [NotificationEvent.DELIVERY_PENDING]: {
    title: 'Delivery created',
    body: (ref) => `Your delivery ${ref} has been created and is awaiting a driver.`,
  },
  [NotificationEvent.DELIVERY_ASSIGNED]: {
    title: 'Driver assigned',
    body: (ref) => `A driver has been assigned to delivery ${ref}.`,
  },
  [NotificationEvent.DELIVERY_IN_PROGRESS]: {
    title: 'Delivery in progress',
    body: (ref) => `Delivery ${ref} is on its way.`,
  },
  [NotificationEvent.DELIVERY_COMPLETED]: {
    title: 'Delivery completed',
    body: (ref) => `Delivery ${ref} has been completed.`,
  },
  [NotificationEvent.DELIVERY_CANCELLED]: {
    title: 'Delivery cancelled',
    body: (ref) => `Delivery ${ref} has been cancelled.`,
  },
};

/** Payload of a `delivery_status_updated` Soroban event. */
export interface DeliveryStatusUpdatedEvent {
  deliveryId: string;
  status: string;
  transactionHash?: string;
}

/** Callback invoked when a delivery status update should be broadcast over WebSocket. */
export type DeliveryWebSocketNotifier = (
  delivery: IDelivery,
  status: DeliveryStatus,
  transactionHash?: string,
) => void;

/** Input accepted by {@link NotificationService.registerDevice}. */
export interface RegisterDeviceInput {
  userId: string;
  token: string;
  platform: IDeviceToken['platform'];
}

/** Input accepted by {@link NotificationService.updatePreferences}. */
export interface UpdatePreferencesInput {
  pushEnabled?: boolean;
  enabledEvents?: NotificationEvent[];
}

/**
 * Orchestrates push notifications for delivery lifecycle transitions.
 *
 * Every send attempt is persisted — including opt-out skips and provider
 * failures — so the notification history is answerable from the database.
 *
 * A failure to notify never propagates to the caller: delivery status
 * transitions must not roll back because a push provider was unreachable.
 * {@link notifyDeliveryTransition} therefore resolves to `null` on failure
 * rather than throwing, and records the reason.
 */
export class NotificationService {
  constructor(
    private readonly preferenceRepository: NotificationPreferenceRepository = defaultPreferenceRepository,
    private readonly notificationRepository: NotificationRepository = defaultNotificationRepository,
    private readonly pushProvider: IPushProvider = fcmProvider,
    private readonly websocketNotifier: DeliveryWebSocketNotifier = () => undefined,
  ) {}

  /**
   * Notify the parties on a delivery that its status changed.
   *
   * Both the sender and the assigned driver are notified when identifiable.
   *
   * @returns The recorded notifications, or an empty array when the status has
   *          no user-facing event.
   */
  async notifyDeliveryTransition(
    delivery: IDelivery,
    status: DeliveryStatus,
  ): Promise<INotification[]> {
    const event = STATUS_EVENTS[status];
    if (!event) {
      logger.debug(`[NotificationService] Status '${status}' has no notifiable event; skipping`);
      return [];
    }

    const recipients = this.resolveRecipients(delivery);
    if (recipients.length === 0) {
      logger.warn(
        `[NotificationService] No identifiable recipients for delivery=${String(delivery._id)}`,
      );
      return [];
    }

    const reference = delivery.trackingNumber ?? String(delivery._id);
    const copy = EVENT_COPY[event];

    const results = await Promise.all(
      recipients.map((userId) =>
        this.dispatch({
          userId,
          event,
          title: copy.title,
          body: copy.body(reference),
          data: {
            deliveryId: String(delivery._id),
            status,
            event,
            ...(delivery.trackingNumber ? { trackingNumber: delivery.trackingNumber } : {}),
          },
          deliveryId: delivery._id as Types.ObjectId,
        }),
      ),
    );

    return results.filter((record): record is INotification => record !== null);
  }

  /**
   * Handle a `delivery_status_updated` event emitted by the smart contract.
   *
   * Applies the on-chain status to the stored delivery and triggers the
   * related user notifications (push and WebSocket).
   */
  async handleDeliveryStatusUpdated(event: DeliveryStatusUpdatedEvent): Promise<{
    delivery: IDelivery;
    notifications: INotification[];
  }> {
    if (!Types.ObjectId.isValid(event.deliveryId)) {
      throw new AppError('Invalid delivery ID', httpStatus.BAD_REQUEST);
    }

    const normalizedStatus = Object.values(DeliveryStatus).find((value) => value === event.status);
    if (!normalizedStatus) {
      throw new AppError(`Unknown delivery status '${event.status}'`, httpStatus.BAD_REQUEST);
    }

    const updated = await Delivery.findByIdAndUpdate(
      event.deliveryId,
      { $set: { status: normalizedStatus } },
      { new: true, runValidators: true },
    ).exec();

    if (!updated) {
      throw new AppError(`Delivery ${event.deliveryId} not found`, httpStatus.NOT_FOUND);
    }

    this.emitWebSocketNotification(updated, normalizedStatus, event.transactionHash);
    const notifications = await this.notifyDeliveryTransition(updated, normalizedStatus);

    return { delivery: updated, notifications };
  }

  /**
   * Best-effort WebSocket broadcast; failures are logged and swallowed so the
   * surrounding delivery transition is not rolled back.
   */
  private emitWebSocketNotification(
    delivery: IDelivery,
    status: DeliveryStatus,
    transactionHash?: string,
  ): void {
    try {
      this.websocketNotifier(delivery, status, transactionHash);
    } catch (error) {
      logger.error(
        `[NotificationService] WebSocket notification failed for delivery=${String(
          delivery._id,
        )}: ` + (error instanceof Error ? error.message : 'Unknown error'),
      );
    }
  }

  /**
   * Send one notification to one user and record the outcome.
   *
   * Errors are caught and recorded rather than rethrown — see the class note
   * on why a push failure must not fail the surrounding operation.
   */
  private async dispatch(input: {
    userId: Types.ObjectId | string;
    event: NotificationEvent;
    title: string;
    body: string;
    data: Record<string, string>;
    deliveryId?: Types.ObjectId;
  }): Promise<INotification | null> {
    try {
      const preference = await this.preferenceRepository.findOrCreateByUserId(input.userId);
      const suppression = this.suppressionReason(preference, input.event);

      if (suppression) {
        return this.record(input, NotificationStatus.SKIPPED, {
          acceptedCount: 0,
          rejectedCount: 0,
          invalidTokens: [],
          failureReason: suppression,
        });
      }

      const tokens = preference.devices.map((device) => device.token);
      const result = await this.pushProvider.send({
        tokens,
        title: input.title,
        body: input.body,
        data: input.data,
      });

      if (result.invalidTokens.length > 0) {
        const pruned = await this.preferenceRepository.pruneTokens(result.invalidTokens);
        logger.info(`[NotificationService] Pruned ${pruned} invalid device token(s)`);
      }

      const status = result.acceptedCount > 0 ? NotificationStatus.SENT : NotificationStatus.FAILED;

      return this.record(input, status, result);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Unknown error';
      logger.error(
        `[NotificationService] Dispatch failed — user=${String(input.userId)} ` +
          `event=${input.event}: ${reason}`,
      );

      // Best-effort audit record; if this write also fails there is nothing
      // further to do without failing the caller's delivery transition.
      try {
        return await this.record(input, NotificationStatus.FAILED, {
          acceptedCount: 0,
          rejectedCount: 0,
          invalidTokens: [],
          failureReason: reason,
        });
      } catch {
        return null;
      }
    }
  }

  /**
   * Why this notification should not be sent, or `undefined` to proceed.
   */
  private suppressionReason(
    preference: INotificationPreference,
    event: NotificationEvent,
  ): string | undefined {
    if (!preference.pushEnabled) return 'User has disabled push notifications';
    if (!preference.enabledEvents.includes(event)) {
      return `User has opted out of '${event}'`;
    }
    if (preference.devices.length === 0) return 'User has no registered devices';
    return undefined;
  }

  /** Persist the outcome of a send attempt. */
  private async record(
    input: {
      userId: Types.ObjectId | string;
      event: NotificationEvent;
      title: string;
      body: string;
      data: Record<string, string>;
      deliveryId?: Types.ObjectId;
    },
    status: NotificationStatus,
    result: PushResult,
  ): Promise<INotification> {
    return this.notificationRepository.create({
      user: new Types.ObjectId(String(input.userId)),
      event: input.event,
      channel: NotificationChannel.PUSH,
      title: input.title,
      body: input.body,
      data: input.data,
      status,
      acceptedCount: result.acceptedCount,
      rejectedCount: result.rejectedCount,
      failureReason: result.failureReason,
      delivery: input.deliveryId,
    } as Partial<INotification>);
  }

  /**
   * Collect the users who should hear about a delivery transition.
   *
   * `sender` is an ObjectId reference; `driverId` and `userId` are free-form
   * strings on the schema, so only well-formed ObjectIds are usable as
   * notification targets. Duplicates are removed so a user who is both sender
   * and driver is notified once.
   */
  private resolveRecipients(delivery: IDelivery): string[] {
    const candidates = [delivery.sender, delivery.userId, delivery.driverId]
      .filter((value): value is NonNullable<typeof value> => Boolean(value))
      .map((value) => String(value))
      .filter((value) => Types.ObjectId.isValid(value));

    return [...new Set(candidates)];
  }

  // ── User-facing preference management ─────────────────────────────────────

  /** Return a user's preferences, initialising defaults on first access. */
  async getPreferences(userId: string): Promise<INotificationPreference> {
    this.assertValidUserId(userId);
    return this.preferenceRepository.findOrCreateByUserId(userId);
  }

  /** Apply a partial update to a user's notification preferences. */
  async updatePreferences(
    userId: string,
    input: UpdatePreferencesInput,
  ): Promise<INotificationPreference> {
    this.assertValidUserId(userId);

    const preference = await this.preferenceRepository.updateForUser(userId, input);
    if (!preference) {
      throw new AppError('Notification preferences not found', httpStatus.NOT_FOUND);
    }

    logger.info(`[NotificationService] Preferences updated for user=${userId}`);
    return preference;
  }

  /** Register or refresh a device push token for a user. */
  async registerDevice(input: RegisterDeviceInput): Promise<INotificationPreference> {
    this.assertValidUserId(input.userId);

    const preference = await this.preferenceRepository.registerDevice(input.userId, {
      token: input.token,
      platform: input.platform,
    });

    logger.info(
      `[NotificationService] Device registered — user=${input.userId} ` +
        `platform=${input.platform}`,
    );
    return preference;
  }

  /** Remove a device token, e.g. on logout. */
  async unregisterDevice(userId: string, token: string): Promise<INotificationPreference> {
    this.assertValidUserId(userId);

    const preference = await this.preferenceRepository.removeDevice(userId, token);
    if (!preference) {
      throw new AppError('Notification preferences not found', httpStatus.NOT_FOUND);
    }
    return preference;
  }

  /** One page of a user's notification history. */
  async listForUser(userId: string, page = 1, limit = 20): Promise<Page<INotification>> {
    this.assertValidUserId(userId);
    return this.notificationRepository.listForUser(userId, page, limit);
  }

  /** Whether the configured push provider can currently send. */
  getProviderStatus(): { provider: string; configured: boolean } {
    return {
      provider: this.pushProvider.name,
      configured: this.pushProvider.isConfigured(),
    };
  }

  private assertValidUserId(userId: string): void {
    if (!Types.ObjectId.isValid(userId)) {
      throw new AppError('Invalid user ID', httpStatus.BAD_REQUEST);
    }
  }
}

export const notificationService = new NotificationService();
