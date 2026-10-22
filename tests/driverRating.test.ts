import request from 'supertest';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import User from '../src/models/User';
import Delivery, { DeliveryStatus } from '../src/models/Delivery';
import DriverProfile from '../src/models/DriverProfile';
import { UserRole, UserStatus } from '../src/interfaces/IUser';
import {
  computeDriverRating,
  resolveSuspension,
  DRIVER_RATING_RULES,
} from '../src/interfaces/IDriverProfile';
import { driverRatingService } from '../src/services/driverRatingService';

jest.mock('../src/config/database', () => ({
  connectDatabase: jest.fn(),
}));

jest.mock('../src/config/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: MongoMemoryServer;

const SETUP_TIMEOUT = 120_000;
const JWT_SECRET = 'test-secret-key-16chars';

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
}, SETUP_TIMEOUT);

afterEach(async () => {
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    await collections[key].deleteMany({});
  }
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
}, 15_000);

beforeEach(() => {
  process.env.JWT_SECRET = JWT_SECRET;
});

const signToken = (userId: string): string => jwt.sign({ userId }, JWT_SECRET, { expiresIn: '1h' });

const createUser = async (role: UserRole = UserRole.DRIVER): Promise<InstanceType<typeof User>> =>
  User.create({
    firstName: 'Test',
    lastName: 'Driver',
    email: `user-${Date.now()}-${Math.random()}@example.com`,
    password: 'Password123!',
    role,
    status: UserStatus.ACTIVE,
  });

/**
 * Seed `completed` completed deliveries with the requested late/finished mix
 * plus `cancelled` cancelled ones for a driver.
 */
const seedDeliveries = async (
  driverId: string,
  counts: { completed: number; delayed: number; cancelled: number },
): Promise<void> => {
  const docs: Record<string, unknown>[] = [];

  for (let i = 0; i < counts.completed; i += 1) {
    const isDelayed = i < counts.delayed;
    docs.push({
      deliveryId: `d-${driverId}-c-${i}-${Math.random()}`,
      driverId,
      status: DeliveryStatus.COMPLETED,
      estimatedDuration: 30,
      actualDuration: isDelayed ? 60 : 25,
    });
  }

  for (let i = 0; i < counts.cancelled; i += 1) {
    docs.push({
      deliveryId: `d-${driverId}-x-${i}-${Math.random()}`,
      driverId,
      status: DeliveryStatus.CANCELLED,
    });
  }

  if (docs.length > 0) await Delivery.insertMany(docs);
};

// ─── Pure rating math ─────────────────────────────────────────────────────────

describe('driver rating formula', () => {
  it('starts a driver with no history at the maximum rating', () => {
    expect(
      computeDriverRating({
        completedDeliveries: 0,
        delayedDeliveries: 0,
        cancelledDeliveries: 0,
        totalAssignedDeliveries: 0,
      }),
    ).toBe(DRIVER_RATING_RULES.MAX_RATING);
  });

  it('deducts for a fully late history', () => {
    expect(
      computeDriverRating({
        completedDeliveries: 10,
        delayedDeliveries: 10,
        cancelledDeliveries: 0,
        totalAssignedDeliveries: 10,
      }),
    ).toBe(3);
  });

  it('deducts for late deliveries and cancellations together', () => {
    expect(
      computeDriverRating({
        completedDeliveries: 5,
        delayedDeliveries: 5,
        cancelledDeliveries: 5,
        totalAssignedDeliveries: 10,
      }),
    ).toBe(1.5);
  });

  it('never returns a rating below zero', () => {
    expect(
      computeDriverRating({
        completedDeliveries: 1,
        delayedDeliveries: 1,
        cancelledDeliveries: 1,
        totalAssignedDeliveries: 2,
      }),
    ).toBeGreaterThanOrEqual(0);
  });
});

describe('resolveSuspension', () => {
  it('does not suspend a driver with too little history', () => {
    expect(resolveSuspension(1.5, DRIVER_RATING_RULES.MIN_COMPLETED_FOR_PENALTY - 1)).toBeNull();
  });

  it('does not suspend a driver above the threshold', () => {
    expect(resolveSuspension(4, 50)).toBeNull();
  });

  it('suspends for the standard duration below the threshold', () => {
    const result = resolveSuspension(1.5, 20);
    expect(result).not.toBeNull();
    const days = Math.round(
      ((result?.suspendedUntil.getTime() ?? 0) - Date.now()) / (24 * 60 * 60 * 1000),
    );
    expect(days).toBe(DRIVER_RATING_RULES.SUSPENSION_DURATION_DAYS);
  });

  it('suspends for the severe duration at the severe threshold', () => {
    const result = resolveSuspension(1, 20);
    const days = Math.round(
      ((result?.suspendedUntil.getTime() ?? 0) - Date.now()) / (24 * 60 * 60 * 1000),
    );
    expect(days).toBe(DRIVER_RATING_RULES.SEVERE_SUSPENSION_DURATION_DAYS);
  });
});

// ─── Service ──────────────────────────────────────────────────────────────────

describe('DriverRatingService', () => {
  it('collects real delivery counts from the database', async () => {
    const driver = await createUser();
    await seedDeliveries(driver._id.toString(), { completed: 4, delayed: 2, cancelled: 1 });

    const metrics = await driverRatingService.collectDriverMetrics(driver._id.toString());

    expect(metrics.completedDeliveries).toBe(4);
    expect(metrics.delayedDeliveries).toBe(2);
    expect(metrics.cancelledDeliveries).toBe(1);
    expect(metrics.totalAssignedDeliveries).toBe(5);
  });

  it('does not count a delivery that finished within the grace window as late', async () => {
    const driver = await createUser();
    await Delivery.create({
      deliveryId: 'within-grace',
      driverId: driver._id.toString(),
      status: DeliveryStatus.COMPLETED,
      estimatedDuration: 30,
      // 32 min vs a 30-min estimate is inside the 10% grace window.
      actualDuration: 32,
    });

    const metrics = await driverRatingService.collectDriverMetrics(driver._id.toString());
    expect(metrics.delayedDeliveries).toBe(0);
  });

  it('persists the computed rating and counters on the profile', async () => {
    const driver = await createUser();
    await seedDeliveries(driver._id.toString(), { completed: 10, delayed: 0, cancelled: 0 });

    const result = await driverRatingService.evaluateDriverRating(driver._id.toString());

    expect(result.rating).toBe(5);

    const profile = await DriverProfile.findOne({ userId: driver._id });
    expect(profile?.rating).toBe(5);
    expect(profile?.completedDeliveries).toBe(10);
    expect(profile?.lastRatingUpdate).toBeInstanceOf(Date);
  });

  it('applies a temporary suspension when the rating is extremely low', async () => {
    const driver = await createUser();
    await seedDeliveries(driver._id.toString(), { completed: 5, delayed: 5, cancelled: 10 });

    const result = await driverRatingService.evaluateDriverRating(driver._id.toString());

    expect(result.rating).toBeLessThan(DRIVER_RATING_RULES.SUSPENSION_RATING_THRESHOLD);
    expect(result.penaltyApplied).toBe(true);
    expect(result.isSuspended).toBe(true);
    expect(result.suspendedUntil).toBeInstanceOf(Date);
    expect(result.suspensionReason).toMatch(/suspended/i);
  });

  it('does not suspend a driver below the minimum history', async () => {
    const driver = await createUser();
    await seedDeliveries(driver._id.toString(), { completed: 2, delayed: 2, cancelled: 2 });

    const result = await driverRatingService.evaluateDriverRating(driver._id.toString());
    expect(result.isSuspended).toBe(false);
  });

  it('lifts a suspension once it has lapsed', async () => {
    const driver = await createUser();
    await DriverProfile.create({
      userId: driver._id,
      isSuspended: true,
      suspendedUntil: new Date(Date.now() - 1000),
      suspensionReason: 'Expired penalty',
    });

    const lifted = await driverRatingService.liftExpiredSuspensions();

    expect(lifted).toBe(1);
    const profile = await DriverProfile.findOne({ userId: driver._id });
    expect(profile?.isSuspended).toBe(false);
    expect(profile?.suspendedUntil).toBeNull();
  });

  it('recalculates every driver that has delivery history', async () => {
    const driverA = await createUser();
    const driverB = await createUser();
    await seedDeliveries(driverA._id.toString(), { completed: 3, delayed: 0, cancelled: 0 });
    await seedDeliveries(driverB._id.toString(), { completed: 5, delayed: 5, cancelled: 10 });

    const summary = await driverRatingService.recalculateAllDriverRatings();

    expect(summary.processed).toBe(2);
    expect(summary.updated).toBe(2);
    expect(summary.suspended).toBe(1);
  });
});

// ─── HTTP endpoints ───────────────────────────────────────────────────────────

describe('GET /api/v1/drivers/:driverId/rating', () => {
  it('returns the driver their own rating', async () => {
    const driver = await createUser();
    const token = signToken(driver._id.toString());
    await seedDeliveries(driver._id.toString(), { completed: 4, delayed: 0, cancelled: 0 });
    await driverRatingService.evaluateDriverRating(driver._id.toString());

    const res = await request(app)
      .get(`/api/v1/drivers/${driver._id.toString()}/rating`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.rating.rating).toBe(5);
    expect(res.body.data.rating.completedDeliveries).toBe(4);
  });

  it('lets an admin read any driver rating', async () => {
    const admin = await createUser(UserRole.ADMIN);
    const driver = await createUser();
    const token = signToken(admin._id.toString());
    await driverRatingService.evaluateDriverRating(driver._id.toString());

    const res = await request(app)
      .get(`/api/v1/drivers/${driver._id.toString()}/rating`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
  });

  it('forbids one driver reading another driver rating', async () => {
    const driver = await createUser();
    const other = await createUser();
    const token = signToken(driver._id.toString());
    await driverRatingService.evaluateDriverRating(other._id.toString());

    const res = await request(app)
      .get(`/api/v1/drivers/${other._id.toString()}/rating`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  it('returns 401 without a token', async () => {
    const driver = await createUser();
    const res = await request(app).get(`/api/v1/drivers/${driver._id.toString()}/rating`);
    expect(res.status).toBe(401);
  });
});

describe('POST /api/v1/drivers/:driverId/rating/recalculate', () => {
  it('recalculates and reports a penalty for a low-rated driver', async () => {
    const admin = await createUser(UserRole.ADMIN);
    const driver = await createUser();
    const token = signToken(admin._id.toString());
    await seedDeliveries(driver._id.toString(), { completed: 5, delayed: 5, cancelled: 10 });

    const res = await request(app)
      .post(`/api/v1/drivers/${driver._id.toString()}/rating/recalculate`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.rating.penaltyApplied).toBe(true);
    expect(res.body.data.rating.isSuspended).toBe(true);
  });

  it('returns 403 for a non-admin driver', async () => {
    const driver = await createUser();
    const token = signToken(driver._id.toString());

    const res = await request(app)
      .post(`/api/v1/drivers/${driver._id.toString()}/rating/recalculate`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });
});

describe('POST /api/v1/drivers/rating/recalculate', () => {
  it('runs the fleet-wide sweep for an admin', async () => {
    const admin = await createUser(UserRole.ADMIN);
    const driver = await createUser();
    const token = signToken(admin._id.toString());
    await seedDeliveries(driver._id.toString(), { completed: 2, delayed: 0, cancelled: 0 });

    const res = await request(app)
      .post('/api/v1/drivers/rating/recalculate')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.result.updated).toBe(1);
  });
});
