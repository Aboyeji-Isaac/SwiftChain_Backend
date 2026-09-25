import mongoose, { Document, Schema, Types } from 'mongoose';

/**
 * Delivery lifecycle events a user can subscribe to.
 *
 * These mirror the `DeliveryStatus` transitions that matter to an end user;
 * intermediate bookkeeping states are deliberately not notifiable.
 */
export enum NotificationEvent {
  DELIVERY_PENDING = 'delivery.pending',
  DELIVERY_ASSIGNED = 'delivery.assigned',
  DELIVERY_IN_PROGRESS = 'delivery.in_progress',
  DELIVERY_COMPLETED = 'delivery.completed',
  DELIVERY_CANCELLED = 'delivery.cancelled',
}

/** Transport a notification can be delivered over. */
export enum NotificationChannel {
  PUSH = 'push',
}

/** A registered push token for one of a user's devices. */
export interface IDeviceToken {
  /** Provider-issued registration token (FCM registration id). */
  token: string;
  platform: 'ios' | 'android' | 'web';
  /** Last time the client re-registered this token. */
  lastSeenAt: Date;
}

export interface INotificationPreference extends Document {
  user: Types.ObjectId;
  /** Master switch — when false, no push is sent regardless of event opt-ins. */
  pushEnabled: boolean;
  /** Events the user has opted into. Absent from the array means opted out. */
  enabledEvents: NotificationEvent[];
  devices: IDeviceToken[];
  createdAt: Date;
  updatedAt: Date;
}

const DeviceTokenSchema = new Schema<IDeviceToken>(
  {
    token: { type: String, required: true, trim: true },
    platform: {
      type: String,
      enum: ['ios', 'android', 'web'],
      required: true,
    },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const NotificationPreferenceSchema = new Schema<INotificationPreference>(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
    pushEnabled: { type: Boolean, default: true },
    enabledEvents: {
      type: [String],
      enum: Object.values(NotificationEvent),
      // New users are opted into every event; they can narrow this afterwards.
      // A factory (not a shared array literal) so each document gets its own
      // copy and one user's edit cannot mutate another's defaults.
      default: (): NotificationEvent[] => Object.values(NotificationEvent),
    },
    devices: { type: [DeviceTokenSchema], default: [] },
  },
  { timestamps: true },
);

// ─── Indexes ────────────────────────────────────────────────────────────────
// Preferences are always resolved by user before a send
// (src/services/notificationService.ts#notifyDeliveryTransition). The unique
// constraint on `user` above already provides that index.

// Token registration looks up the owning preference document by raw token so a
// device that moves between accounts can be detached from the previous owner.
// The index is UNIQUE (multikey over the devices array): a push token maps to
// exactly one active account at any instant, so concurrent registrations for
// the same token cannot both own it — the losing write fails with E11000 and
// retries (see NotificationPreferenceRepository#registerDevice).
NotificationPreferenceSchema.index({ 'devices.token': 1 }, { unique: true });

const NotificationPreference = mongoose.model<INotificationPreference>(
  'NotificationPreference',
  NotificationPreferenceSchema,
);

export default NotificationPreference;
export { NotificationPreference };
