/**
 * WebhookSubscription.ts
 *
 * A merchant-registered endpoint that receives HTTP POST callbacks when a
 * delivery they own changes state. One merchant may register several
 * endpoints (e.g. staging + production); each row is independent.
 *
 * The signing `secret` is generated server-side and never returned again
 * after creation/rotation — callers verify the `X-SwiftChain-Signature`
 * header against it (see `services/webhookService.ts#verifySignature`).
 */

import mongoose, { Schema, Document, Model, Types } from 'mongoose';

/** Delivery lifecycle events a merchant can subscribe to. */
export enum WebhookEvent {
  DELIVERY_PENDING = 'delivery.pending',
  DELIVERY_FUNDED = 'delivery.funded',
  DELIVERY_ASSIGNED = 'delivery.assigned',
  DELIVERY_IN_PROGRESS = 'delivery.in_progress',
  DELIVERY_COMPLETED = 'delivery.completed',
  DELIVERY_CANCELLED = 'delivery.cancelled',
}

export interface IWebhookSubscription extends Document {
  /** Owning merchant (the delivery's `sender`). */
  merchantId: Types.ObjectId;
  /** HTTPS endpoint the merchant's server exposes for callbacks. */
  url: string;
  /** HMAC-SHA256 signing secret. Excluded from queries unless explicitly selected. */
  secret: string;
  /** Events this endpoint wants to receive. */
  events: WebhookEvent[];
  /** Toggle without deleting the registration. */
  isActive: boolean;
  description?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IWebhookSubscriptionModel extends Model<IWebhookSubscription> {}

const WebhookSubscriptionSchema = new Schema<IWebhookSubscription>(
  {
    merchantId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    url: { type: String, required: true, trim: true },
    secret: { type: String, required: true, select: false },
    events: {
      type: [String],
      enum: Object.values(WebhookEvent),
      required: true,
      validate: {
        validator: (value: WebhookEvent[]): boolean => Array.isArray(value) && value.length > 0,
        message: 'At least one event must be selected.',
      },
    },
    isActive: { type: Boolean, default: true },
    description: { type: String, trim: true, maxlength: 500 },
  },
  { timestamps: true },
);

// Dispatch lookup: active subscriptions for a merchant, filtered by event.
WebhookSubscriptionSchema.index({ merchantId: 1, isActive: 1 });

export const WebhookSubscription = mongoose.model<IWebhookSubscription, IWebhookSubscriptionModel>(
  'WebhookSubscription',
  WebhookSubscriptionSchema,
);

export default WebhookSubscription;
