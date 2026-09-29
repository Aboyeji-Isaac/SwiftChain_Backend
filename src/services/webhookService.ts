/**
 * webhookService.ts
 *
 * Dispatches delivery lifecycle events to merchant-registered HTTP
 * endpoints, and owns the registry those endpoints are stored in.
 *
 * ── Delivery model ──────────────────────────────────────────────────────────
 * A dispatch never blocks or fails the delivery-status transition that
 * triggered it (mirrors `notificationService`'s fire-and-forget contract).
 * Every attempt — success, failure, or skip — is persisted to
 * `WebhookDeliveryAttempt` so retries survive a process restart and the
 * history is answerable from the database rather than logs.
 *
 * Failed attempts are retried with exponential backoff (base * 2^(n-1),
 * capped, plus jitter) by the sweep in `jobs/webhookRetryJob.ts`, up to
 * `WEBHOOK_MAX_RETRIES` attempts, after which the attempt is marked
 * `exhausted` and left for the merchant to investigate.
 *
 * ── Signature verification ──────────────────────────────────────────────────
 * Every POST carries `X-SwiftChain-Signature: sha256=<hex>`, an
 * HMAC-SHA256 of the exact JSON body using the subscription's secret. The
 * secret is generated on registration/rotation and never stored or returned
 * in plaintext again — only its hash-backed comparisons are needed after
 * that point.
 */

import crypto from 'crypto';
import axios from 'axios';
import { StatusCodes } from 'http-status-codes';
import { Types } from 'mongoose';
import {
  WebhookSubscription,
  IWebhookSubscription,
  WebhookEvent,
} from '../models/WebhookSubscription';
import {
  WebhookDeliveryAttempt,
  IWebhookDeliveryAttempt,
  WebhookDeliveryStatus,
} from '../models/WebhookDeliveryAttempt';
import { IDelivery, DeliveryStatus } from '../models/Delivery';
import AppError from '../utils/AppError';
import env from '../config/env';
import logger from '../config/logger';

// ─── DTOs ──────────────────────────────────────────────────────────────────────

export interface RegisterWebhookInput {
  merchantId: string;
  url: string;
  events: WebhookEvent[];
  description?: string;
}

export interface UpdateWebhookInput {
  url?: string;
  events?: WebhookEvent[];
  isActive?: boolean;
  description?: string;
}

/** Registration/rotation result — the only time the plaintext secret is available. */
export interface WebhookWithSecret {
  webhook: IWebhookSubscription;
  secret: string;
}

// ─── Status → event mapping ─────────────────────────────────────────────────

/** Mirrors `notificationService`'s STATUS_EVENTS: internal statuses raise no event. */
const STATUS_EVENTS: Partial<Record<DeliveryStatus, WebhookEvent>> = {
  [DeliveryStatus.PENDING]: WebhookEvent.DELIVERY_PENDING,
  [DeliveryStatus.FUNDED]: WebhookEvent.DELIVERY_FUNDED,
  [DeliveryStatus.ASSIGNED]: WebhookEvent.DELIVERY_ASSIGNED,
  [DeliveryStatus.IN_PROGRESS]: WebhookEvent.DELIVERY_IN_PROGRESS,
  [DeliveryStatus.COMPLETED]: WebhookEvent.DELIVERY_COMPLETED,
  [DeliveryStatus.CANCELLED]: WebhookEvent.DELIVERY_CANCELLED,
};

// ─── Service ───────────────────────────────────────────────────────────────────

export class WebhookService {
  // ── Registry ────────────────────────────────────────────────────────────

  /** Register a new endpoint for a merchant. Generates and returns a one-time secret. */
  async registerWebhook(input: RegisterWebhookInput): Promise<WebhookWithSecret> {
    this.assertValidObjectId(input.merchantId, 'merchantId');
    this.assertValidUrl(input.url);

    if (!input.events || input.events.length === 0) {
      throw new AppError('At least one event must be selected.', StatusCodes.BAD_REQUEST);
    }

    const secret = this.generateSecret();

    const webhook = await WebhookSubscription.create({
      merchantId: input.merchantId,
      url: input.url,
      secret,
      events: input.events,
      description: input.description,
    });

    logger.info(
      `[WebhookService] Registered webhook — merchant=${input.merchantId} id=${String(
        webhook._id,
      )}`,
    );

    return { webhook, secret };
  }

  /** List a merchant's registered webhooks, newest first. Secret is never included. */
  async listForMerchant(merchantId: string): Promise<IWebhookSubscription[]> {
    this.assertValidObjectId(merchantId, 'merchantId');
    return WebhookSubscription.find({ merchantId }).sort({ createdAt: -1 });
  }

  /** Fetch one webhook, scoped to its owning merchant. */
  async getById(merchantId: string, id: string): Promise<IWebhookSubscription> {
    this.assertValidObjectId(merchantId, 'merchantId');
    this.assertValidObjectId(id, 'id');

    const webhook = await WebhookSubscription.findOne({ _id: id, merchantId });
    if (!webhook) {
      throw new AppError('Webhook not found.', StatusCodes.NOT_FOUND);
    }
    return webhook;
  }

  /** Update a merchant's webhook. */
  async updateWebhook(
    merchantId: string,
    id: string,
    input: UpdateWebhookInput,
  ): Promise<IWebhookSubscription> {
    if (input.url !== undefined) this.assertValidUrl(input.url);
    if (input.events !== undefined && input.events.length === 0) {
      throw new AppError('At least one event must be selected.', StatusCodes.BAD_REQUEST);
    }

    const webhook = await this.getById(merchantId, id);

    if (input.url !== undefined) webhook.url = input.url;
    if (input.events !== undefined) webhook.events = input.events;
    if (input.isActive !== undefined) webhook.isActive = input.isActive;
    if (input.description !== undefined) webhook.description = input.description;

    await webhook.save();
    return webhook;
  }

  /** Permanently remove a webhook registration. */
  async deleteWebhook(merchantId: string, id: string): Promise<void> {
    const webhook = await this.getById(merchantId, id);
    await webhook.deleteOne();
    logger.info(`[WebhookService] Deleted webhook — merchant=${merchantId} id=${id}`);
  }

  /** Issue a new signing secret, invalidating the old one immediately. */
  async rotateSecret(merchantId: string, id: string): Promise<WebhookWithSecret> {
    this.assertValidObjectId(merchantId, 'merchantId');
    this.assertValidObjectId(id, 'id');

    const secret = this.generateSecret();
    const webhook = await WebhookSubscription.findOneAndUpdate(
      { _id: id, merchantId },
      { $set: { secret } },
      { new: true },
    );

    if (!webhook) {
      throw new AppError('Webhook not found.', StatusCodes.NOT_FOUND);
    }

    logger.info(`[WebhookService] Rotated secret — merchant=${merchantId} id=${id}`);
    return { webhook, secret };
  }

  // ── Dispatch ────────────────────────────────────────────────────────────

  /**
   * Notify every active webhook a merchant has registered for this delivery's
   * new status. Never throws — a merchant's unreachable server must not roll
   * back a delivery transition that already committed.
   */
  async dispatchDeliveryEvent(delivery: IDelivery, status: DeliveryStatus): Promise<void> {
    const event = STATUS_EVENTS[status];
    if (!event) {
      logger.debug(`[WebhookService] Status '${status}' raises no webhook event; skipping`);
      return;
    }

    const merchantId = delivery.sender ?? delivery.userId;
    if (!merchantId || !Types.ObjectId.isValid(String(merchantId))) {
      logger.debug(
        `[WebhookService] Delivery ${String(delivery._id)} has no identifiable merchant; skipping`,
      );
      return;
    }

    try {
      const subscriptions = await WebhookSubscription.find({
        merchantId,
        isActive: true,
        events: event,
      }).select('+secret');

      if (subscriptions.length === 0) return;

      const payload = this.buildPayload(delivery, event, status);

      await Promise.all(
        subscriptions.map((webhook) =>
          this.createAndSendAttempt(webhook, event, delivery, payload),
        ),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error(
        `[WebhookService] Dispatch failed for delivery=${String(delivery._id)}: ${message}`,
      );
    }
  }

  /** Create the attempt record, then perform the first send. */
  private async createAndSendAttempt(
    webhook: IWebhookSubscription,
    event: WebhookEvent,
    delivery: IDelivery,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const attempt = await WebhookDeliveryAttempt.create({
      webhook: webhook._id,
      merchantId: webhook.merchantId,
      event,
      delivery: delivery._id,
      payload,
      maxAttempts: env.WEBHOOK_MAX_RETRIES,
    });

    await this.sendAttempt(attempt, webhook);
  }

  /**
   * Perform a single HTTP POST for a delivery attempt and record the
   * outcome. Used both for the first send and for retries from the sweep.
   */
  async sendAttempt(
    attempt: IWebhookDeliveryAttempt,
    webhookInput?: IWebhookSubscription,
  ): Promise<void> {
    const webhook =
      webhookInput ?? (await WebhookSubscription.findById(attempt.webhook).select('+secret'));

    if (!webhook || !webhook.isActive) {
      attempt.status = WebhookDeliveryStatus.EXHAUSTED;
      attempt.lastError = 'Webhook subscription is missing or inactive.';
      attempt.nextRetryAt = null;
      await attempt.save();
      return;
    }

    const body = JSON.stringify(attempt.payload);
    const signature = this.sign(body, webhook.secret);
    const attemptNumber = attempt.attempts + 1;

    try {
      const response = await axios.post(webhook.url, attempt.payload, {
        timeout: env.WEBHOOK_REQUEST_TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/json',
          'X-SwiftChain-Event': attempt.event,
          'X-SwiftChain-Delivery-Id': String(attempt.delivery),
          'X-SwiftChain-Attempt-Id': String(attempt._id),
          'X-SwiftChain-Signature': signature,
          'X-SwiftChain-Timestamp': new Date().toISOString(),
        },
        validateStatus: (statusCode) => statusCode >= 200 && statusCode < 300,
        // Re-serialize would break the signature; axios only serializes
        // objects for us, and JSON.stringify is deterministic for the plain
        // object payload we build, so `body` above matches what is sent.
        transformRequest: [() => body],
      });

      attempt.attempts = attemptNumber;
      attempt.status = WebhookDeliveryStatus.SUCCESS;
      attempt.lastAttemptAt = new Date();
      attempt.lastStatusCode = response.status;
      attempt.lastError = undefined;
      attempt.nextRetryAt = null;
      await attempt.save();

      logger.info(
        `[WebhookService] Delivered — webhook=${String(webhook._id)} event=${attempt.event} ` +
          `attempt=${attemptNumber} status=${response.status}`,
      );
    } catch (error) {
      const statusCode = axios.isAxiosError(error) ? error.response?.status : undefined;
      const message = error instanceof Error ? error.message : 'Unknown error';

      attempt.attempts = attemptNumber;
      attempt.lastAttemptAt = new Date();
      attempt.lastStatusCode = statusCode;
      attempt.lastError = message;

      if (attemptNumber >= attempt.maxAttempts) {
        attempt.status = WebhookDeliveryStatus.EXHAUSTED;
        attempt.nextRetryAt = null;
        logger.warn(
          `[WebhookService] Exhausted retries — webhook=${String(webhook._id)} ` +
            `event=${attempt.event} attempts=${attemptNumber}: ${message}`,
        );
      } else {
        attempt.status = WebhookDeliveryStatus.FAILED;
        attempt.nextRetryAt = this.computeNextRetry(attemptNumber);
        logger.warn(
          `[WebhookService] Delivery failed, will retry — webhook=${String(webhook._id)} ` +
            `event=${
              attempt.event
            } attempt=${attemptNumber} nextRetryAt=${attempt.nextRetryAt.toISOString()}: ${message}`,
        );
      }

      await attempt.save();
    }
  }

  /**
   * Retry every due, retryable attempt. Called by the retry sweep job.
   *
   * @returns Number of attempts processed in this sweep.
   */
  async retryDueAttempts(): Promise<number> {
    const due = await WebhookDeliveryAttempt.find({
      status: WebhookDeliveryStatus.FAILED,
      nextRetryAt: { $lte: new Date() },
    })
      .sort({ nextRetryAt: 1 })
      .limit(env.WEBHOOK_RETRY_BATCH_SIZE);

    if (due.length === 0) return 0;

    await Promise.all(due.map((attempt) => this.sendAttempt(attempt)));
    return due.length;
  }

  // ── Signing ─────────────────────────────────────────────────────────────

  /** Compute the `sha256=<hex>` signature merchants verify against. */
  sign(body: string, secret: string): string {
    const digest = crypto.createHmac('sha256', secret).update(body).digest('hex');
    return `sha256=${digest}`;
  }

  /**
   * Constant-time comparison a merchant's server (or our own tests) can use
   * to verify an inbound `X-SwiftChain-Signature` header.
   */
  verifySignature(body: string, signatureHeader: string, secret: string): boolean {
    const expected = Buffer.from(this.sign(body, secret));
    const actual = Buffer.from(signatureHeader);

    if (expected.length !== actual.length) return false;
    return crypto.timingSafeEqual(expected, actual);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private generateSecret(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  private buildPayload(
    delivery: IDelivery,
    event: WebhookEvent,
    status: DeliveryStatus,
  ): Record<string, unknown> {
    return {
      event,
      timestamp: new Date().toISOString(),
      data: {
        deliveryId: String(delivery._id),
        trackingNumber: delivery.trackingNumber,
        status,
        driverId: delivery.driverId,
      },
    };
  }

  /** Exponential backoff with +/-20% jitter, capped at `WEBHOOK_RETRY_MAX_MS`. */
  private computeNextRetry(attemptNumber: number): Date {
    const exponential = env.WEBHOOK_RETRY_BASE_MS * Math.pow(2, attemptNumber - 1);
    const capped = Math.min(exponential, env.WEBHOOK_RETRY_MAX_MS);
    const jitter = capped * 0.2 * (Math.random() * 2 - 1);
    return new Date(Date.now() + capped + jitter);
  }

  private assertValidObjectId(value: string, field: string): void {
    if (!Types.ObjectId.isValid(value)) {
      throw new AppError(`${field} must be a valid ObjectId.`, StatusCodes.BAD_REQUEST);
    }
  }

  private assertValidUrl(url: string): void {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && env.NODE_ENV === 'production') {
        throw new Error('non-https');
      }
    } catch {
      throw new AppError('url must be a valid HTTPS URL.', StatusCodes.BAD_REQUEST);
    }
  }
}

export const webhookService = new WebhookService();
export default webhookService;
