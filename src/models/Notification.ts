import mongoose, { Document, Schema, Types } from 'mongoose';
import { NotificationChannel, NotificationEvent } from './NotificationPreference';

/** Terminal and in-flight states for a single notification attempt. */
export enum NotificationStatus {
  /** Accepted by the provider for at least one device. */
  SENT = 'sent',
  /** Rejected by the provider, or every target device failed. */
  FAILED = 'failed',
  /** Suppressed because the user opted out or has no registered device. */
  SKIPPED = 'skipped',
}

export interface INotification extends Document {
  user: Types.ObjectId;
  event: NotificationEvent;
  channel: NotificationChannel;
  title: string;
  body: string;
  /** Structured payload the client app uses to deep-link. */
  data: Record<string, string>;
  status: NotificationStatus;
  /** Number of device tokens the provider accepted. */
  acceptedCount: number;
  /** Number of device tokens the provider rejected. */
  rejectedCount: number;
  /** Provider error or skip reason, when not `SENT`. */
  failureReason?: string;
  /** Delivery this notification concerns, when applicable. */
  delivery?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const NotificationSchema = new Schema<INotification>(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    event: {
      type: String,
      enum: Object.values(NotificationEvent),
      required: true,
    },
    channel: {
      type: String,
      enum: Object.values(NotificationChannel),
      default: NotificationChannel.PUSH,
    },
    title: { type: String, required: true, trim: true },
    body: { type: String, required: true, trim: true },
    data: { type: Schema.Types.Mixed, default: {} },
    status: {
      type: String,
      enum: Object.values(NotificationStatus),
      required: true,
    },
    acceptedCount: { type: Number, default: 0 },
    rejectedCount: { type: Number, default: 0 },
    failureReason: { type: String },
    delivery: {
      type: Schema.Types.ObjectId,
      ref: 'Delivery',
    },
  },
  { timestamps: true },
);

// ─── Indexes ────────────────────────────────────────────────────────────────
// GET /api/v1/notifications returns a user's history newest-first
// (src/services/notificationService.ts#listForUser).
NotificationSchema.index({ user: 1, createdAt: -1 });

// Supports "what was sent for this delivery" lookups during support triage.
NotificationSchema.index({ delivery: 1, createdAt: -1 });

const Notification = mongoose.model<INotification>('Notification', NotificationSchema);

export default Notification;
export { Notification };
