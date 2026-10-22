import request from 'supertest';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Express } from 'express';

import Delivery, { DeliveryStatus } from '../../src/models/Delivery';
import User from '../../src/models/User';

/**
 * End-to-end Delivery flow integration tests.
 *
 * Issue #211 unified the two delivery surfaces: every flow — CRUD *and*
 * status transitions — now reads and writes the single canonical
 * `src/models/Delivery.ts` model through the Controller -> Service ->
 * Repository layers. This suite exercises each as a real, chained flow
 * against a live MongoDB instance (mongodb-memory-server) and pins the
 * single-source-of-truth property: writes via one surface are immediately
 * visible through the other.
 */

jest.mock('../../src/config/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../../src/services/notificationService', () => ({
  notificationService: { notifyDeliveryTransition: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../src/services/webhookService', () => ({
  webhookService: { dispatchDeliveryEvent: jest.fn().mockResolvedValue(undefined) },
}));

let app: Express;
let mongoServer: MongoMemoryServer;
// 16+ chars: satisfies the env schema minimum and matches the CI secret.
const jwtSecret = 'test-secret-key-16chars';

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongoServer.getUri();
  process.env.JWT_SECRET = jwtSecret;

  const mod = await import('../../src/app');
  app = mod.default;
  await mongoose.connect(mongoServer.getUri());
});

afterEach(async () => {
  await Delivery.deleteMany({});
  await User.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

const driverToken = (): string => jwt.sign({ userId: 'flow-driver', role: 'driver' }, jwtSecret);

const crudPayload = {
  trackingNumber: 'FLOW-001',
  customer: {
    name: 'Ada Lovelace',
    phone: '+15550001111',
    email: 'ada@example.com',
  },
  pickup: {
    address: '1 Analytical Engine Way',
    city: 'London',
    state: 'LDN',
    zipCode: 'EC1A1BB',
  },
  dropoff: {
    address: '2 Difference St',
    city: 'London',
    state: 'LDN',
    zipCode: 'EC1A1BC',
  },
  package: {
    description: 'Punched cards',
    weight: 1.2,
    size: 'Small',
    isFragile: false,
    requiresSignature: false,
  },
  deliveryFee: 9.5,
  escrowAmount: 50,
};

describe('Delivery CRUD flow: create -> read -> update -> archive -> restore', () => {
  it('carries a single delivery through its full lifecycle with real persistence at each step', async () => {
    const createRes = await request(app)
      .post('/api/v1/deliveries')
      .set('Idempotency-Key', `test-${Date.now()}-${Math.random()}`)
      .send(crudPayload);
    expect(createRes.status).toBe(201);
    const id = createRes.body.data.id ?? createRes.body.data._id;
    expect(createRes.body.data.status).toBe('pending');

    const getRes = await request(app).get(`/api/v1/deliveries/${id}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.data.trackingNumber).toBe('FLOW-001');

    const updateRes = await request(app)
      .patch(`/api/v1/deliveries/${id}`)
      .send({ status: 'assigned', notes: 'Driver en route' });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.data.status).toBe('assigned');
    expect(updateRes.body.data.notes).toBe('Driver en route');

    const archiveRes = await request(app).patch(`/api/v1/deliveries/${id}/archive`);
    expect(archiveRes.status).toBe(200);
    expect(archiveRes.body.data.isDeleted).toBe(true);

    // Archived deliveries are excluded from both direct lookup and listing.
    const getAfterArchive = await request(app).get(`/api/v1/deliveries/${id}`);
    expect(getAfterArchive.status).toBe(404);

    const listAfterArchive = await request(app).get('/api/v1/deliveries');
    expect(listAfterArchive.body.data).toHaveLength(0);

    const restoreRes = await request(app).patch(`/api/v1/deliveries/${id}/restore`);
    expect(restoreRes.status).toBe(200);
    expect(restoreRes.body.data.isDeleted).toBe(false);

    const listAfterRestore = await request(app).get('/api/v1/deliveries');
    expect(listAfterRestore.body.data).toHaveLength(1);
    expect(listAfterRestore.body.data[0].trackingNumber).toBe('FLOW-001');

    const finalGet = await request(app).get(`/api/v1/deliveries/${id}`);
    expect(finalGet.status).toBe(200);
    expect(finalGet.body.data.status).toBe('assigned');
  });

  it('rejects creating a delivery with a tracking number already in the database', async () => {
    await request(app)
      .post('/api/v1/deliveries')
      .set('Idempotency-Key', `test-${Date.now()}-${Math.random()}`)
      .send(crudPayload);
    const dupe = await request(app)
      .post('/api/v1/deliveries')
      .set('Idempotency-Key', `test-${Date.now()}-${Math.random()}`)
      .send(crudPayload);

    expect(dupe.status).toBe(409);
    expect(dupe.body.status).toBe('error');
  });

  it('returns 404 when reading, updating, or archiving a delivery id that does not exist', async () => {
    const fakeId = new mongoose.Types.ObjectId().toHexString();

    const getRes = await request(app).get(`/api/v1/deliveries/${fakeId}`);
    expect(getRes.status).toBe(404);

    const archiveRes = await request(app).patch(`/api/v1/deliveries/${fakeId}/archive`);
    expect(archiveRes.status).toBe(404);
  });
});

describe('Delivery status-transition flow: authenticated driver walks a delivery to completion', () => {
  /** Seed a canonical delivery in the given status. */
  const seedDelivery = async (status: string) =>
    Delivery.create({
      trackingNumber: `TRK-${new mongoose.Types.ObjectId().toHexString().slice(-8)}`,
      status,
      customer: { name: 'Ada Lovelace', phone: '+15550001111' },
      pickup: { address: '1 Analytical Engine Way' },
      dropoff: { address: '2 Difference St' },
      package: { description: 'Punched cards', weight: 1.2 },
      pickupCoordinates: { lat: 6.5, lng: 3.3, address: '1 Analytical Engine Way' },
      dropoffCoordinates: { lat: 6.6, lng: 3.4, address: '2 Difference St' },
    });

  it('walks a delivery through every valid transition end to end as an authenticated driver', async () => {
    const delivery = await seedDelivery(DeliveryStatus.PENDING);
    const token = driverToken();

    const path = [DeliveryStatus.ASSIGNED, DeliveryStatus.IN_PROGRESS, DeliveryStatus.COMPLETED];
    const currentId = delivery._id.toString();

    for (const nextStatus of path) {
      const res = await request(app)
        .put(`/api/v1/deliveries/${currentId}/status`)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: nextStatus });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe(nextStatus);
    }

    const finalDoc = await Delivery.findById(currentId);
    expect(finalDoc?.status).toBe(DeliveryStatus.COMPLETED);
  });

  it('rejects a transition that skips states in the workflow', async () => {
    const delivery = await seedDelivery(DeliveryStatus.PENDING);
    const token = driverToken();

    const res = await request(app)
      .put(`/api/v1/deliveries/${delivery._id.toString()}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: DeliveryStatus.IN_PROGRESS });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/cannot transition/i);
  });

  it('rejects a transition once a delivery has already reached a terminal state', async () => {
    const delivery = await seedDelivery(DeliveryStatus.COMPLETED);
    const token = driverToken();

    const res = await request(app)
      .put(`/api/v1/deliveries/${delivery._id.toString()}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: DeliveryStatus.ASSIGNED });

    expect(res.status).toBe(400);
  });

  it('rejects the retired legacy status vocabulary with an explicit message (issue #211)', async () => {
    const delivery = await seedDelivery(DeliveryStatus.PENDING);
    const token = driverToken();

    const res = await request(app)
      .put(`/api/v1/deliveries/${delivery._id.toString()}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'in_transit' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/legacy status/i);

    // The write is rejected before any state moves.
    const unchanged = await Delivery.findById(delivery._id.toString());
    expect(unchanged?.status).toBe(DeliveryStatus.PENDING);
  });

  it('returns 404 when the delivery id is well-formed but does not exist', async () => {
    const token = driverToken();
    const missingId = new mongoose.Types.ObjectId().toHexString();

    const res = await request(app)
      .put(`/api/v1/deliveries/${missingId}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: DeliveryStatus.ASSIGNED });

    expect(res.status).toBe(404);
  });

  it('returns 400 for a malformed delivery id before touching the database', async () => {
    const token = driverToken();

    const res = await request(app)
      .put('/api/v1/deliveries/not-a-valid-id/status')
      .set('Authorization', `Bearer ${token}`)
      .send({ status: DeliveryStatus.ASSIGNED });

    expect(res.status).toBe(400);
  });

  it('rejects an unrecognized status value', async () => {
    const delivery = await seedDelivery(DeliveryStatus.PENDING);
    const token = driverToken();

    const res = await request(app)
      .put(`/api/v1/deliveries/${delivery._id.toString()}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'teleported' });

    expect(res.status).toBe(400);
  });
});

describe('Single source of truth: CRUD surface and status surface share one collection (issue #211)', () => {
  it('reflects a status written through PUT /:id/status in the CRUD read path immediately', async () => {
    const createRes = await request(app)
      .post('/api/v1/deliveries')
      .set('Idempotency-Key', `test-${Date.now()}-${Math.random()}`)
      .send(crudPayload);
    expect(createRes.status).toBe(201);
    const id = createRes.body.data.id ?? createRes.body.data._id;

    const token = driverToken();
    const statusRes = await request(app)
      .put(`/api/v1/deliveries/${id}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: DeliveryStatus.ASSIGNED });
    expect(statusRes.status).toBe(200);

    const getRes = await request(app).get(`/api/v1/deliveries/${id}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.data.status).toBe(DeliveryStatus.ASSIGNED);
  });
});
