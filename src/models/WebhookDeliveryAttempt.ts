/**
 * WebhookDeliveryAttempt.ts
 *
 * One row per (webhook subscription, delivery event) dispatch. Tracks retry
 * state so a crashed process can pick up where it left off — the retry
 * sweep (`jobs/webhookRetryJob.ts`) queries this collection directly rather
 * than relying on in-memory timers.
 */

import mongoose, { Schema, Document, Model, Types } from 'mongoose';
import { WebhookEvent } from './WebhookSubscription';

export enum WebhookDeliveryStatus {
  PENDING = 'pending',
  SUCCESS = 'success',
  FAILED = 'failed',
  /** Retries exhausted; will not be attempted again automatically. */
  EXHAUSTED = 'exhausted',
}

export interface IWebhookDeliveryAttempt extends Document {
  webhook: Types.ObjectId;
  merchantId: Types.ObjectId;
  event: WebhookEvent;
  delivery: Types.ObjectId;
  payload: Record<string, unknown>;
  status: WebhookDeliveryStatus;
  attempts: number;
  maxAttempts: number;
  lastAttemptAt?: Date;
  lastStatusCode?: number;
  lastError?: string;
  /** When the next retry sweep should pick this attempt up again. Unset once SUCCESS/EXHAUSTED. */
  nextRetryAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IWebhookDeliveryAttemptModel extends Model<IWebhookDeliveryAttempt> {}

const WebhookDeliveryAttemptSchema = new Schema<IWebhookDeliveryAttempt>(
  {
    webhook: {
      type: Schema.Types.ObjectId,
      ref: 'WebhookSubscription',
      required: true,
      index: true,
    },
    merchantId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    event: { type: String, enum: Object.values(WebhookEvent), required: true },
    delivery: { type: Schema.Types.ObjectId, ref: 'Delivery', required: true, index: true },
    payload: { type: Schema.Types.Mixed, required: true },
    status: {
      type: String,
      enum: Object.values(WebhookDeliveryStatus),
      default: WebhookDeliveryStatus.PENDING,
      required: true,
    },
    attempts: { type: Number, default: 0, min: 0 },
    maxAttempts: { type: Number, required: true, min: 1 },
    lastAttemptAt: { type: Date },
    lastStatusCode: { type: Number },
    lastError: { type: String },
    nextRetryAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Retry sweep: due, retryable attempts ordered for a bounded batch scan.
WebhookDeliveryAttemptSchema.index({ status: 1, nextRetryAt: 1 });

export const WebhookDeliveryAttempt = mongoose.model<
  IWebhookDeliveryAttempt,
  IWebhookDeliveryAttemptModel
>('WebhookDeliveryAttempt', WebhookDeliveryAttemptSchema);

export default WebhookDeliveryAttempt;
