import { Types } from 'mongoose';
import NotificationPreference, {
  IDeviceToken,
  INotificationPreference,
  NotificationEvent,
} from '../models/NotificationPreference';
import { BaseRepository } from './BaseRepository';
import { WriteOptions } from './types';

/** Fields a user is allowed to change on their own preferences. */
export interface PreferenceUpdate {
  pushEnabled?: boolean;
  enabledEvents?: NotificationEvent[];
}

/**
 * Persistence gateway for per-user notification preferences and device tokens.
 */
export class NotificationPreferenceRepository extends BaseRepository<INotificationPreference> {
  constructor() {
    super(NotificationPreference);
  }

  /** Preferences for a user, or `null` if they have never been initialised. */
  async findByUserId(userId: string | Types.ObjectId): Promise<INotificationPreference | null> {
    if (typeof userId === 'string' && !this.isValidId(userId)) return null;
    return this.findOne({ user: userId });
  }

  /**
   * Return a user's preferences, creating the default document if absent.
   *
   * Uses an upsert with `$setOnInsert` so two concurrent first-time requests
   * cannot race into a duplicate-key error — the second one matches the
   * document the first inserted.
   */
  async findOrCreateByUserId(userId: string | Types.ObjectId): Promise<INotificationPreference> {
    const preference = await this.model
      .findOneAndUpdate(
        { user: userId },
        { $setOnInsert: { user: userId } },
        { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true },
      )
      .exec();

    return preference as INotificationPreference;
  }

  /** Apply a partial preference update, creating the document if needed. */
  async updateForUser(
    userId: string | Types.ObjectId,
    update: PreferenceUpdate,
    options?: WriteOptions,
  ): Promise<INotificationPreference | null> {
    const set: Record<string, unknown> = {};
    if (typeof update.pushEnabled === 'boolean') set.pushEnabled = update.pushEnabled;
    if (update.enabledEvents) set.enabledEvents = update.enabledEvents;

    if (Object.keys(set).length === 0) {
      return this.findOrCreateByUserId(userId);
    }

    return this.model
      .findOneAndUpdate(
        { user: userId },
        { $set: set, $setOnInsert: { user: userId } },
        {
          new: true,
          upsert: true,
          setDefaultsOnInsert: true,
          runValidators: options?.runValidators ?? true,
          session: options?.session,
        },
      )
      .exec() as Promise<INotificationPreference | null>;
  }

  /**
   * Register (or refresh) a device token for a user.
   *
   * A token identifies a device install, not a person: when the same token
   * appears under a different account the device has been handed over or the
   * app re-authenticated, so it is detached from the previous owner first.
   * Skipping that step would push one user's delivery updates to another's
   * phone.
   *
   * Concurrency: a unique multikey index on `devices.token` guarantees a
   * token maps to at most one user at any instant. The claim loop relies on
   * it: if two users race to attach the same token, the second attach fails
   * with a duplicate-key error and retries after detaching the winner, so
   * exactly one owner survives. It also terminates: each retry removes one
   * competing registration before re-attaching.
   */
  async registerDevice(
    userId: string | Types.ObjectId,
    device: Omit<IDeviceToken, 'lastSeenAt'>,
  ): Promise<INotificationPreference> {
    const MAX_CLAIM_ATTEMPTS = 5;

    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt += 1) {
      // Guard: an already-registered token is refreshed in place rather than
      // detached and re-attached, so a re-registration never races with a
      // concurrent detach of the same token.
      const refreshed = await this.model
        .findOneAndUpdate(
          { user: userId, 'devices.token': device.token },
          {
            $set: {
              'devices.$.platform': device.platform,
              'devices.$.lastSeenAt': new Date(),
            },
          },
          { new: true },
        )
        .exec();

      if (refreshed) return refreshed as INotificationPreference;

      // Detach the token from every other user in a single atomic operation.
      await this.model
        .updateMany(
          { user: { $ne: userId }, 'devices.token': device.token },
          { $pull: { devices: { token: device.token } } },
        )
        .exec();

      try {
        const updated = await this.model
          .findOneAndUpdate(
            { user: userId },
            {
              $push: { devices: { ...device, lastSeenAt: new Date() } },
              $setOnInsert: { user: userId },
            },
            { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true },
          )
          .exec();

        if (!updated) {
          throw new Error('Failed to upsert notification preferences for user');
        }

        return updated as INotificationPreference;
      } catch (err) {
        // Duplicate key on `devices.token`: a parallel registration attached
        // the token between our detach and attach. Detach again and retry —
        // the unique index guarantees only one of the racing writes can win.
        const isDuplicateToken =
          typeof err === 'object' &&
          err !== null &&
          'code' in err &&
          (err as { code?: number }).code === 11000;

        if (!isDuplicateToken || attempt === MAX_CLAIM_ATTEMPTS - 1) {
          throw err;
        }
      }
    }

    // Unreachable: the loop either returns or throws on its final attempt.
    throw new Error('Could not register device token due to concurrent registration contention');
  }

  /** Remove a device token from a user (logout or manual unsubscribe). */
  async removeDevice(
    userId: string | Types.ObjectId,
    token: string,
  ): Promise<INotificationPreference | null> {
    return this.model
      .findOneAndUpdate({ user: userId }, { $pull: { devices: { token } } }, { new: true })
      .exec() as Promise<INotificationPreference | null>;
  }

  /**
   * Drop tokens the provider reported as permanently invalid.
   *
   * Called after a send so uninstalled apps stop consuming provider quota.
   */
  async pruneTokens(tokens: string[]): Promise<number> {
    if (tokens.length === 0) return 0;
    const result = await this.model
      .updateMany(
        { 'devices.token': { $in: tokens } },
        { $pull: { devices: { token: { $in: tokens } } } },
      )
      .exec();
    return result.modifiedCount ?? 0;
  }
}

export const notificationPreferenceRepository = new NotificationPreferenceRepository();
