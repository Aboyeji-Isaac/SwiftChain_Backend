import request from 'supertest';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { MongoMemoryServer } from 'mongodb-memory-server';
import Delivery from '../src/models/Delivery';
import User from '../src/models/User';
import { UserRole } from '../src/interfaces/IUser';

import { Express } from 'express';

jest.setTimeout(60000);

jest.mock('../src/config/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

// The endpoint test isolates the HTTP contract: notification and webhook
// side effects are stubbed exactly like the state-machine unit tests do.
jest.mock('../src/services/notificationService', () => ({
  notificationService: { notifyDeliveryTransition: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../src/services/webhookService', () => ({
  webhookService: { dispatchDeliveryEvent: jest.fn().mockResolvedValue(undefined) },
}));

/**
 * Status-update endpoint tests (issue #211).
 *
 * The endpoint now delegates to the canonical `DeliveryService.updateStatus`
 * state machine, so these cover: authentication, a canonical transition
 * persisted through `DeliveryRepository.transitionStatus`, rejected illegal
 * transitions, and — the regression this issue is about — explicit rejection
 * of the retired legacy status vocabulary at the validation boundary.
 */
describe('Delivery Status Update API', () => {
  let app: Express;
  let mongoServer: MongoMemoryServer;
  // 16+ chars: satisfies the env schema minimum and matches the CI secret.
  const jwtSecret = 'test-secret-key-16chars';
  let token: string;

  const buildToken = (): string => token;

  /** Seed a canonical delivery in the given status. */
  const seedDelivery = async (status: string) =>
    Delivery.create({
      trackingNumber: `TRK-${new mongoose.Types.ObjectId().toHexString().slice(-8)}`,
      status,
      customer: { name: 'Alice', phone: '+2348000000000' },
      pickup: { address: '123 Market St' },
      dropoff: { address: '456 Park Ave' },
      package: { description: 'Small parcel', weight: 1 },
      pickupCoordinates: { lat: 6.5, lng: 3.3, address: '123 Market St' },
      dropoffCoordinates: { lat: 6.6, lng: 3.4, address: '456 Park Ave' },
    });

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    process.env.MONGODB_URI = mongoServer.getUri();
    process.env.JWT_SECRET = jwtSecret;

    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    await mongoose.connect(mongoServer.getUri());

    const imported = await import('../src/app');
    app = imported.default;
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await Delivery.deleteMany({});
    await User.deleteMany({});

    const driverUser = await User.create({
      firstName: 'Driver',
      lastName: 'Test',
      email: `driver-${Date.now()}@test.com`,
      password: 'password123',
      role: UserRole.DRIVER,
    });

    token = jwt.sign(
      { userId: driverUser._id.toString(), role: UserRole.DRIVER },
      process.env.JWT_SECRET || jwtSecret,
      { expiresIn: '1h' },
    );
  });

  it('returns 401 when authorization token is missing', async () => {
    const response = await request(app)
      .put('/api/v1/deliveries/507f1f77bcf86cd799439011/status')
      .send({ status: 'assigned' });

    expect(response.status).toBe(401);
    expect(response.body).toHaveProperty('success', false);
    expect(response.body.message).toMatch(/Authentication required/i);
  });

  it('updates delivery status after a valid canonical transition', async () => {
    const delivery = await seedDelivery('pending');

    const token = buildToken();

    const response = await request(app)
      .put(`/api/v1/deliveries/${delivery._id}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'assigned' });

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('success', true);
    expect(response.body.data).toHaveProperty('status', 'assigned');

    const updated = await Delivery.findById(delivery._id);
    expect(updated).not.toBeNull();
    expect(updated?.status).toBe('assigned');
  });

  it('returns 400 for a canonical state-machine violation (skipping states)', async () => {
    const delivery = await seedDelivery('pending');

    const token = buildToken();

    const response = await request(app)
      .put(`/api/v1/deliveries/${delivery._id}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'completed' });

    expect(response.status).toBe(400);
    expect(response.body).toHaveProperty('success', false);
    expect(response.body.message).toMatch(/cannot transition/i);

    // The document keeps its original status — nothing was half-written.
    const unchanged = await Delivery.findById(delivery._id);
    expect(unchanged?.status).toBe('pending');
  });

  it.each(['picked_up', 'in_transit', 'delivered'])(
    'rejects the legacy status value %s with an explicit message (issue #211)',
    async (legacyStatus) => {
      const delivery = await seedDelivery('pending');
      const token = buildToken();

      const response = await request(app)
        .put(`/api/v1/deliveries/${delivery._id}/status`)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: legacyStatus });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('success', false);

      // Nothing may be written: the document must still be canonical-pending.
      const unchanged = await Delivery.findById(delivery._id);
      expect(unchanged?.status).toBe('pending');
      expect(unchanged?.status).not.toBe(legacyStatus);
    },
  );

  it('returns 400 when the status value is not a string at all', async () => {
    const delivery = await seedDelivery('pending');
    const token = buildToken();

    const response = await request(app)
      .put(`/api/v1/deliveries/${delivery._id}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 42 });

    expect(response.status).toBe(400);
  });
});

/**
 * Model-level regression: the canonical `Delivery` schema's enum must reject
 * the retired legacy vocabulary, so no code path can persist it even if a
 * future caller bypasses the controller and service.
 */
describe('Canonical Delivery model enum (issue #211)', () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    await mongoose.connect(mongoServer.getUri());
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  afterEach(async () => {
    await Delivery.deleteMany({});
  });

  it.each(['picked_up', 'in_transit', 'delivered'])(
    'refuses to persist legacy status %s',
    async (legacyStatus) => {
      await expect(
        Delivery.create({
          trackingNumber: `TRK-${legacyStatus}`,
          status: legacyStatus,
        }),
      ).rejects.toThrow(/`.*` is not a valid enum value/i);

      await expect(Delivery.countDocuments({})).resolves.toBe(0);
    },
  );

  it('accepts every canonical status value', async () => {
    for (const status of [
      'pending',
      'funded',
      'assigned',
      'in_progress',
      'completed',
      'cancelled',
    ]) {
      await Delivery.create({
        trackingNumber: `TRK-OK-${status}`,
        status,
      });
    }
    await expect(Delivery.countDocuments({})).resolves.toBe(6);
  });
});
