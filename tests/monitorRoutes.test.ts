/**
 * Integration tests for the /api/v1/monitor routes.
 */

import request from 'supertest';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import User from '../src/models/User';
import { IndexerStatus } from '../src/models/IndexerStatus';
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

jest.mock('../src/blockchain/soroban.service', () => ({
  sorobanService: {
    getLatestLedger: jest.fn().mockResolvedValue(1000),
  },
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

const signToken = (userId: string): string =>
  jwt.sign({ userId }, JWT_SECRET, { expiresIn: '1h' });

const createUser = async (role: UserRole): Promise<InstanceType<typeof User>> =>
  User.create({
    firstName: 'Test',
    lastName: 'User',
    email: `user-${Date.now()}-${Math.random()}@example.com`,
    password: 'Password123!',
    role,
    status: UserStatus.ACTIVE,
  });

describe('GET /api/v1/monitor/indexer-lag', () => {
  it('returns 401 without a token', async () => {
    const res = await request(app).get('/api/v1/monitor/indexer-lag');
    expect(res.status).toBe(401);
  });

  it('returns 403 for a non-admin user', async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    const user = await createUser(UserRole.USER);
    const token = signToken(user._id.toString());

    const res = await request(app)
      .get('/api/v1/monitor/indexer-lag')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  it('returns the lag status for an admin user', async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    const admin = await createUser(UserRole.ADMIN);
    const token = signToken(admin._id.toString());

    await IndexerStatus.create({ network: 'testnet', lastProcessedLedger: 990 });

    const res = await request(app)
      .get('/api/v1/monitor/indexer-lag')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      network: 'testnet',
      processedLedger: 990,
      networkLedger: 1000,
      lagLedgers: 10,
    });
  });
});

describe('GET /api/v1/monitor/indexer-lag/alerts', () => {
  it('returns 401 without a token', async () => {
    const res = await request(app).get('/api/v1/monitor/indexer-lag/alerts');
    expect(res.status).toBe(401);
  });

  it('returns an empty alert list for an admin user when none exist', async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    const admin = await createUser(UserRole.ADMIN);
    const token = signToken(admin._id.toString());

    const res = await request(app)
      .get('/api/v1/monitor/indexer-lag/alerts')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.alerts).toEqual([]);
    expect(res.body.data.count).toBe(0);
  });
});
