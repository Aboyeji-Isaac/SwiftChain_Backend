/**
 * Delivery creation audit tests (issue #301).
 *
 * Audit findings this suite locks down (the creation path previously had only
 * three API-level cases, and the whole suite could not even load because
 * `src/routes/delivery.routes.ts` referenced an undefined `validate`
 * identifier — fixed alongside this ticket):
 *
 *  1. Creation defaults: `status`, `isDeleted` and the default `XLM` assets.
 *  2. The escrow funding deadline (`fundBy`) is stamped when an escrow amount
 *     is configured and omitted otherwise (issue #247).
 *  3. The `created` milestone is appended to the delivery event log.
 *  4. Unsupported escrow assets are rejected at the validation boundary.
 *  5. A repeated `Idempotency-Key` replays the cached response instead of
 *     creating a duplicate delivery.
 *
 * Runs against mongodb-memory-server through the real Express app — no inline
 * mocks or hardcoded fixtures beyond the request payloads themselves.
 */

import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { Delivery, DeliveryStatus } from '../src/models/Delivery';
import DeliveryEvent, { DeliveryMilestone } from '../src/models/DeliveryEvent';
import env from '../src/config/env';

jest.mock('../src/config/database', () => ({
  connectDatabase: jest.fn(),
}));

jest.mock('../src/config/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

let trackingSequence = 0;
const nextTrackingNumber = (): string => `AUDIT-${Date.now()}-${++trackingSequence}`;

/** Shape of the request body built by {@link buildInput}. */
type CreationPayload = {
  trackingNumber: string;
  customer: { name: string; phone: string; email?: string };
  pickup: { address: string; city?: string; state?: string };
  dropoff: { address: string; city?: string; state?: string };
  package: { description: string; weight: number };
  deliveryFee: number;
  escrowAmount: number;
};

const buildInput = (overrides: Record<string, unknown> = {}): CreationPayload =>
  ({
    trackingNumber: nextTrackingNumber(),
    customer: {
      name: 'Audit Reviewer',
      phone: '+15550002222',
      email: 'audit@example.com',
    },
    pickup: { address: '10 Audit Lane', city: 'Lagos', state: 'LA' },
    dropoff: { address: '20 Review Ave', city: 'Abuja', state: 'AB' },
    package: { description: 'Audit parcel', weight: 1.5 },
    deliveryFee: 25,
    escrowAmount: 200,
    ...overrides,
  }) as CreationPayload;

const postDelivery = (body: Record<string, unknown>, idempotencyKey?: string): request.Test =>
  request(app)
    .post('/api/v1/deliveries')
    .set('Idempotency-Key', idempotencyKey ?? `audit-${Date.now()}-${Math.random()}`)
    .send(body);

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
}, 30_000);

beforeEach(async () => {
  await Promise.all([Delivery.deleteMany({}), DeliveryEvent.deleteMany({})]);
});

describe('Delivery creation audit (issue #301)', () => {
  describe('creation defaults', () => {
    it('creates a pending, non-archived delivery with default XLM assets', async () => {
      const res = await postDelivery(buildInput());

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe(DeliveryStatus.PENDING);
      expect(res.body.data.isDeleted).toBe(false);
      expect(res.body.data.escrowAsset.code).toBe('XLM');
      expect(res.body.data.deliveryFeeAsset.code).toBe('XLM');
      expect(res.body.data.cancellationReason).toBeUndefined();
    });

    it('persists the delivery in the database', async () => {
      const input = buildInput();
      const res = await postDelivery(input);

      const stored = await Delivery.findOne({ trackingNumber: input.trackingNumber });
      expect(stored).not.toBeNull();
      expect(String(stored!._id)).toBe(res.body.data._id);
      expect(stored!.escrowAmount).toBe(200);
    });
  });

  describe('escrow funding deadline (issue #247)', () => {
    it('stamps fundBy at creation when an escrow amount is configured', async () => {
      const before = Date.now();
      const res = await postDelivery(buildInput({ escrowAmount: 500 }));

      expect(res.status).toBe(201);
      const fundBy = new Date(res.body.data.fundBy).getTime();
      const min = before + env.ESCROW_FUNDING_WINDOW_SECONDS * 1000;
      const max = Date.now() + env.ESCROW_FUNDING_WINDOW_SECONDS * 1000;
      expect(fundBy).toBeGreaterThanOrEqual(min);
      expect(fundBy).toBeLessThanOrEqual(max);
    });

    it('leaves fundBy unset when no escrow amount is configured', async () => {
      const res = await postDelivery(buildInput({ escrowAmount: 0 }));

      expect(res.status).toBe(201);
      expect(res.body.data.fundBy).toBeUndefined();
    });
  });

  describe('creation milestone', () => {
    it('appends a `created` milestone as seq 1 of the delivery event log', async () => {
      const res = await postDelivery(buildInput());

      const event = await DeliveryEvent.findOne({ delivery: res.body.data._id });
      expect(event).not.toBeNull();
      expect(event!.event).toBe(DeliveryMilestone.CREATED);
      expect(event!.fromStatus).toBeNull();
      expect(event!.toStatus).toBe(DeliveryStatus.PENDING);
      expect(event!.seq).toBe(1);
    });
  });

  describe('validation boundary', () => {
    it('rejects an unsupported escrow asset', async () => {
      const res = await postDelivery(buildInput({ escrowAsset: { code: 'DOGE' } }));

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(await Delivery.countDocuments({})).toBe(0);
    });

    it('rejects a missing customer payload', async () => {
      const input = buildInput() as Record<string, unknown>;
      delete input.customer;

      const res = await postDelivery(input);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  describe('idempotent creation', () => {
    it('replays the cached response for a repeated Idempotency-Key', async () => {
      const input = buildInput();
      const key = `audit-idem-${Date.now()}`;

      const first = await postDelivery(input, key);
      expect(first.status).toBe(201);

      // The response record is persisted fire-and-forget before the response
      // is written; give it a moment to land before replaying the key.
      await new Promise((resolve) => setTimeout(resolve, 250));

      const replay = await postDelivery(input, key);
      expect(replay.status).toBe(201);
      expect(replay.headers['idempotency-key-replay']).toBe('true');
      expect(replay.body.data.trackingNumber).toBe(input.trackingNumber);

      expect(await Delivery.countDocuments({ trackingNumber: input.trackingNumber })).toBe(1);
    });
  });
});
