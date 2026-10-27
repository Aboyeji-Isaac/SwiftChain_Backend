import axios from 'axios';
import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { webhookService, DEFAULT_WEBHOOK_SCHEMA_VERSION } from '../src/services/webhookService';
import { WebhookSubscription, WebhookEvent } from '../src/models/WebhookSubscription';
import {
  WebhookDeliveryAttempt,
  WebhookDeliveryStatus,
} from '../src/models/WebhookDeliveryAttempt';
import { IDelivery, DeliveryStatus } from '../src/models/Delivery';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('WebhookService - Versioning and Batching (Issue #243)', () => {
  let mongoServer: MongoMemoryServer;
  const merchantId = new Types.ObjectId().toString();

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();
    await mongoose.connect(uri);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    webhookService.clearPendingBatches();
    webhookService.setFlushWindowMs(100);
    await WebhookSubscription.deleteMany({});
    await WebhookDeliveryAttempt.deleteMany({});
  });

  afterEach(() => {
    webhookService.clearPendingBatches();
  });

  describe('Webhook Registration & allowBatch', () => {
    it('registers a webhook with allowBatch flag set to true', async () => {
      const { webhook, secret } = await webhookService.registerWebhook({
        merchantId,
        url: 'https://merchant.example.com/webhooks',
        events: [WebhookEvent.DELIVERY_IN_PROGRESS, WebhookEvent.DELIVERY_COMPLETED],
        allowBatch: true,
        description: 'Batch-enabled webhook',
      });

      expect(webhook._id).toBeDefined();
      expect(webhook.allowBatch).toBe(true);
      expect(secret).toHaveLength(64);

      const persisted = await WebhookSubscription.findById(webhook._id);
      expect(persisted?.allowBatch).toBe(true);
    });

    it('defaults allowBatch to false when omitted', async () => {
      const { webhook } = await webhookService.registerWebhook({
        merchantId,
        url: 'https://merchant.example.com/webhooks',
        events: [WebhookEvent.DELIVERY_COMPLETED],
      });

      expect(webhook.allowBatch).toBe(false);
      const persisted = await WebhookSubscription.findById(webhook._id);
      expect(persisted?.allowBatch).toBe(false);
    });

    it('updates allowBatch via updateWebhook', async () => {
      const { webhook } = await webhookService.registerWebhook({
        merchantId,
        url: 'https://merchant.example.com/webhooks',
        events: [WebhookEvent.DELIVERY_COMPLETED],
        allowBatch: false,
      });

      const updated = await webhookService.updateWebhook(merchantId, String(webhook._id), {
        allowBatch: true,
      });

      expect(updated.allowBatch).toBe(true);
    });
  });

  describe('Payload Versioning (schemaVersion)', () => {
    it('dispatches single-event payload with schemaVersion 1.0 and valid signature', async () => {
      const { webhook, secret } = await webhookService.registerWebhook({
        merchantId,
        url: 'https://merchant.example.com/webhook-v1',
        events: [WebhookEvent.DELIVERY_COMPLETED],
        allowBatch: false,
      });

      mockedAxios.post.mockResolvedValueOnce({ status: 200, data: { ok: true } });

      const mockDelivery = {
        _id: new Types.ObjectId(),
        sender: new Types.ObjectId(merchantId),
        trackingNumber: 'TRK-1001',
        status: DeliveryStatus.COMPLETED,
        driverId: 'DRV-1',
      } as unknown as IDelivery;

      await webhookService.dispatchDeliveryEvent(mockDelivery, DeliveryStatus.COMPLETED);

      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
      const [url, sentPayload, config] = mockedAxios.post.mock.calls[0];

      expect(url).toBe('https://merchant.example.com/webhook-v1');
      const payloadObj = sentPayload as Record<string, unknown>;
      expect(payloadObj.schemaVersion).toBe(DEFAULT_WEBHOOK_SCHEMA_VERSION);
      expect(payloadObj.event).toBe(WebhookEvent.DELIVERY_COMPLETED);
      expect((payloadObj.data as Record<string, unknown>).trackingNumber).toBe('TRK-1001');

      // Verify signature over the versioned payload body
      const headers = config?.headers as Record<string, string>;
      const signatureHeader = headers['X-SwiftChain-Signature'];
      expect(signatureHeader).toMatch(/^sha256=[a-f0-9]{64}$/);

      const isValidSignature = webhookService.verifySignature(
        JSON.stringify(payloadObj),
        signatureHeader,
        secret,
      );
      expect(isValidSignature).toBe(true);

      // Verify delivery attempt was persisted with schemaVersion in payload
      const attempt = await WebhookDeliveryAttempt.findOne({ webhook: webhook._id });
      expect(attempt).toBeDefined();
      expect(attempt?.status).toBe(WebhookDeliveryStatus.SUCCESS);
      expect(attempt?.payload.schemaVersion).toBe(DEFAULT_WEBHOOK_SCHEMA_VERSION);
    });
  });

  describe('Event Batching & Flush Window', () => {
    it('groups multiple events for batch-enabled subscriber into a single delivery.batch request', async () => {
      const { webhook, secret } = await webhookService.registerWebhook({
        merchantId,
        url: 'https://merchant.example.com/batch',
        events: [WebhookEvent.DELIVERY_IN_PROGRESS, WebhookEvent.DELIVERY_COMPLETED],
        allowBatch: true,
      });

      mockedAxios.post.mockResolvedValueOnce({ status: 200, data: { received: true } });

      const delivery1 = {
        _id: new Types.ObjectId(),
        sender: new Types.ObjectId(merchantId),
        trackingNumber: 'TRK-B1',
        status: DeliveryStatus.IN_PROGRESS,
        driverId: 'DRV-1',
      } as unknown as IDelivery;

      const delivery2 = {
        _id: new Types.ObjectId(),
        sender: new Types.ObjectId(merchantId),
        trackingNumber: 'TRK-B2',
        status: DeliveryStatus.COMPLETED,
        driverId: 'DRV-2',
      } as unknown as IDelivery;

      // Dispatch 2 events within the flush window
      await webhookService.dispatchDeliveryEvent(delivery1, DeliveryStatus.IN_PROGRESS);
      await webhookService.dispatchDeliveryEvent(delivery2, DeliveryStatus.COMPLETED);

      // Before flush, per-event attempts are recorded in PENDING state
      const pendingAttempts = await WebhookDeliveryAttempt.find({ webhook: webhook._id });
      expect(pendingAttempts).toHaveLength(2);
      expect(pendingAttempts[0].status).toBe(WebhookDeliveryStatus.PENDING);
      expect(pendingAttempts[1].status).toBe(WebhookDeliveryStatus.PENDING);

      // Not yet dispatched via HTTP
      expect(mockedAxios.post).not.toHaveBeenCalled();

      // Explicitly flush or await flush window
      await webhookService.flushBatch(String(webhook._id));

      // Now exactly one HTTP POST request was dispatched
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);

      const [url, sentPayload, config] = mockedAxios.post.mock.calls[0];
      expect(url).toBe('https://merchant.example.com/batch');

      const batchPayload = sentPayload as Record<string, unknown>;
      expect(batchPayload.event).toBe(WebhookEvent.DELIVERY_BATCH);
      expect(batchPayload.schemaVersion).toBe(DEFAULT_WEBHOOK_SCHEMA_VERSION);

      const data = batchPayload.data as {
        batchSize: number;
        events: Array<Record<string, unknown>>;
      };
      expect(data.batchSize).toBe(2);
      expect(data.events).toHaveLength(2);
      expect(data.events[0].event).toBe(WebhookEvent.DELIVERY_IN_PROGRESS);
      expect(data.events[1].event).toBe(WebhookEvent.DELIVERY_COMPLETED);

      // Headers check
      const headers = config?.headers as Record<string, string>;
      expect(headers['X-SwiftChain-Event']).toBe(WebhookEvent.DELIVERY_BATCH);
      expect(headers['X-SwiftChain-Batch-Size']).toBe('2');

      // Signature verification over the batch body
      const isValid = webhookService.verifySignature(
        JSON.stringify(batchPayload),
        headers['X-SwiftChain-Signature'],
        secret,
      );
      expect(isValid).toBe(true);

      // Per-event tracking: both attempts updated to SUCCESS
      const updatedAttempts = await WebhookDeliveryAttempt.find({ webhook: webhook._id });
      expect(updatedAttempts).toHaveLength(2);
      expect(updatedAttempts[0].status).toBe(WebhookDeliveryStatus.SUCCESS);
      expect(updatedAttempts[0].attempts).toBe(1);
      expect(updatedAttempts[0].lastStatusCode).toBe(200);
      expect(updatedAttempts[1].status).toBe(WebhookDeliveryStatus.SUCCESS);
      expect(updatedAttempts[1].attempts).toBe(1);
      expect(updatedAttempts[1].lastStatusCode).toBe(200);
    });

    it('honours the flush window timer automatically', async () => {
      webhookService.setFlushWindowMs(50);

      const { webhook } = await webhookService.registerWebhook({
        merchantId,
        url: 'https://merchant.example.com/timer-batch',
        events: [WebhookEvent.DELIVERY_COMPLETED],
        allowBatch: true,
      });

      mockedAxios.post.mockResolvedValueOnce({ status: 200, data: { ok: true } });

      const delivery = {
        _id: new Types.ObjectId(),
        sender: new Types.ObjectId(merchantId),
        trackingNumber: 'TRK-TIME',
        status: DeliveryStatus.COMPLETED,
        driverId: 'DRV-TIME',
      } as unknown as IDelivery;

      await webhookService.dispatchDeliveryEvent(delivery, DeliveryStatus.COMPLETED);

      // Wait for flush window timer to fire
      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
      const attempts = await WebhookDeliveryAttempt.find({ webhook: webhook._id });
      expect(attempts[0].status).toBe(WebhookDeliveryStatus.SUCCESS);
    });

    it('records failed attempts and schedules retry when batched dispatch fails', async () => {
      const { webhook } = await webhookService.registerWebhook({
        merchantId,
        url: 'https://merchant.example.com/failing-batch',
        events: [WebhookEvent.DELIVERY_COMPLETED],
        allowBatch: true,
      });

      mockedAxios.post.mockRejectedValueOnce(
        Object.assign(new Error('Service Unavailable'), {
          isAxiosError: true,
          response: { status: 503 },
        }),
      );

      const delivery = {
        _id: new Types.ObjectId(),
        sender: new Types.ObjectId(merchantId),
        trackingNumber: 'TRK-FAIL',
        status: DeliveryStatus.COMPLETED,
        driverId: 'DRV-1',
      } as unknown as IDelivery;

      await webhookService.dispatchDeliveryEvent(delivery, DeliveryStatus.COMPLETED);
      await webhookService.flushBatch(String(webhook._id));

      const attempt = await WebhookDeliveryAttempt.findOne({ webhook: webhook._id });
      expect(attempt?.status).toBe(WebhookDeliveryStatus.FAILED);
      expect(attempt?.attempts).toBe(1);
      expect(attempt?.lastStatusCode).toBe(503);
      expect(attempt?.lastError).toContain('Service Unavailable');
      expect(attempt?.nextRetryAt).toBeDefined();
    });

    it('flushAllBatches flushes all subscriptions with pending batches', async () => {
      const merchantId2 = new Types.ObjectId().toString();
      await webhookService.registerWebhook({
        merchantId,
        url: 'https://merchant1.example.com',
        events: [WebhookEvent.DELIVERY_COMPLETED],
        allowBatch: true,
      });
      await webhookService.registerWebhook({
        merchantId: merchantId2,
        url: 'https://merchant2.example.com',
        events: [WebhookEvent.DELIVERY_COMPLETED],
        allowBatch: true,
      });

      mockedAxios.post.mockResolvedValue({ status: 200, data: {} });

      const d1 = {
        _id: new Types.ObjectId(),
        sender: new Types.ObjectId(merchantId),
        trackingNumber: 'TRK-1',
        status: DeliveryStatus.COMPLETED,
      } as unknown as IDelivery;

      const d2 = {
        _id: new Types.ObjectId(),
        sender: new Types.ObjectId(merchantId2),
        trackingNumber: 'TRK-2',
        status: DeliveryStatus.COMPLETED,
      } as unknown as IDelivery;

      await webhookService.dispatchDeliveryEvent(d1, DeliveryStatus.COMPLETED);
      await webhookService.dispatchDeliveryEvent(d2, DeliveryStatus.COMPLETED);

      await webhookService.flushAllBatches();

      expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    });
  });
});
