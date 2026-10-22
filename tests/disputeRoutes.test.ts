/**
 * Integration tests for the /api/v1/disputes routes.
 */

import request from 'supertest';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import User from '../src/models/User';
import { Dispute, DisputeStatus } from '../src/models/Dispute';
import { UserRole, UserStatus } from '../src/interfaces/IUser';

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

const JWT_SECRET = 'test-secret-key-16chars';

const signToken = (userId: string): string => jwt.sign({ userId }, JWT_SECRET, { expiresIn: '1h' });

const createUser = async (role: UserRole): Promise<InstanceType<typeof User>> =>
  User.create({
    firstName: 'Test',
    lastName: 'User',
    email: `user-${Date.now()}-${Math.random()}@example.com`,
    password: 'Password123!',
    role,
    status: UserStatus.ACTIVE,
  });

describe('GET /api/v1/disputes', () => {
  it('returns 401 without a token', async () => {
    const res = await request(app).get('/api/v1/disputes');
    expect(res.status).toBe(401);
  });

  it('returns 403 for a non-admin user', async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    const user = await createUser(UserRole.USER);
    const token = signToken(user._id.toString());

    const res = await request(app).get('/api/v1/disputes').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  it('lists disputes for an admin user', async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    const admin = await createUser(UserRole.ADMIN);
    const token = signToken(admin._id.toString());

    await Dispute.create({
      disputeId: 'dispute-1',
      deliveryId: 'delivery-1',
      openedBy: 'GABC',
      status: DisputeStatus.OPEN,
      openedLedger: 10,
    });

    const res = await request(app).get('/api/v1/disputes').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.disputes).toHaveLength(1);
    expect(res.body.data.disputes[0].disputeId).toBe('dispute-1');
    expect(res.body.data.meta.totalItems).toBe(1);
  });
});

describe('GET /api/v1/disputes/:disputeId', () => {
  it('returns 404 for an unknown disputeId', async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    const admin = await createUser(UserRole.ADMIN);
    const token = signToken(admin._id.toString());

    const res = await request(app)
      .get('/api/v1/disputes/does-not-exist')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });

  it('returns the dispute for a known disputeId', async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    const admin = await createUser(UserRole.ADMIN);
    const token = signToken(admin._id.toString());

    await Dispute.create({
      disputeId: 'dispute-2',
      deliveryId: 'delivery-2',
      openedBy: 'GABC',
      status: DisputeStatus.OPEN,
      openedLedger: 10,
    });

    const res = await request(app)
      .get('/api/v1/disputes/dispute-2')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.dispute.disputeId).toBe('dispute-2');
  });
});
