import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import adminRoutes from '../src/routes/adminRoutes';
import errorHandler from '../src/middleware/errorHandler';
import User from '../src/models/User';
import { DlqEntry, DlqStatus } from '../src/models/DlqEntry';
import { UserRole, UserStatus } from '../src/interfaces/IUser';
import { stellarService } from '../src/services/stellarService';

// ─── Module mocks ──────────────────────────────────────────────────────────────

jest.mock('../src/config/database', () => ({
  connectDatabase: jest.fn(),
}));

jest.mock('../src/config/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

// Stellar is never called over the network; the retry path only needs a
// controllable submitEscrowLock.
jest.mock('../src/services/stellarService', () => ({
  stellarService: { submitEscrowLock: jest.fn() },
}));

const submitEscrowLock = stellarService.submitEscrowLock as jest.Mock;

// ─── In-memory MongoDB ─────────────────────────────────────────────────────────

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
}, 120_000);

afterEach(async () => {
  jest.clearAllMocks();
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    await collections[key].deleteMany({});
  }
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
}, 15_000);

// ─── App under test ────────────────────────────────────────────────────────────

const JWT_SECRET = 'test-secret-key-16chars';

const app = express();
app.use(express.json());
app.use('/v1/admin', adminRoutes);
app.use(errorHandler);

// ─── Helpers ───────────────────────────────────────────────────────────────────

const signToken = (userId: string): string => jwt.sign({ userId }, JWT_SECRET, { expiresIn: '1h' });

const createUser = async (role: UserRole): Promise<InstanceType<typeof User>> =>
  User.create({
    firstName: 'Test',
    lastName: 'User',
    email: `dlq-${role}-${Date.now()}-${Math.random()}@example.com`,
    password: 'Password123!',
    role,
    status: UserStatus.ACTIVE,
  });

const createEntry = async (
  overrides: Partial<{ status: DlqStatus; retryCount: number; errorReason: string }> = {},
): Promise<InstanceType<typeof DlqEntry>> =>
  DlqEntry.create({
    payload: { deliveryId: 'delivery-1', signedXdr: 'AAAA', payerAddress: 'GPAYER' },
    errorReason: overrides.errorReason ?? 'initial failure',
    status: overrides.status ?? DlqStatus.PENDING,
    retryCount: overrides.retryCount ?? 0,
  });

const adminToken = async (): Promise<string> => {
  process.env.JWT_SECRET = JWT_SECRET;
  const admin = await createUser(UserRole.ADMIN);
  return signToken(admin._id.toString());
};

// ─── GET /v1/admin/dlq ─────────────────────────────────────────────────────────

describe('GET /v1/admin/dlq', () => {
  it('returns an empty page when there are no DLQ entries', async () => {
    const token = await adminToken();

    const res = await request(app).get('/v1/admin/dlq').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.entries).toEqual([]);
    expect(res.body.data.pagination).toEqual({ total: 0, page: 1, limit: 10, totalPages: 0 });
  });

  it('returns populated entries from the database', async () => {
    const token = await adminToken();
    await createEntry({ errorReason: 'horizon timeout' });

    const res = await request(app).get('/v1/admin/dlq').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.entries).toHaveLength(1);
    expect(res.body.data.entries[0].errorReason).toBe('horizon timeout');
    expect(res.body.data.entries[0].status).toBe(DlqStatus.PENDING);
    expect(res.body.data.pagination.total).toBe(1);
  });

  it('paginates the entries using page and limit', async () => {
    const token = await adminToken();
    await Promise.all([createEntry(), createEntry(), createEntry()]);

    const firstPage = await request(app)
      .get('/v1/admin/dlq?page=1&limit=2')
      .set('Authorization', `Bearer ${token}`);
    const secondPage = await request(app)
      .get('/v1/admin/dlq?page=2&limit=2')
      .set('Authorization', `Bearer ${token}`);

    expect(firstPage.status).toBe(200);
    expect(firstPage.body.data.entries).toHaveLength(2);
    expect(firstPage.body.data.pagination).toEqual({
      total: 3,
      page: 1,
      limit: 2,
      totalPages: 2,
    });

    expect(secondPage.status).toBe(200);
    expect(secondPage.body.data.entries).toHaveLength(1);
    expect(secondPage.body.data.pagination.page).toBe(2);
  });

  it('rejects unauthenticated requests', async () => {
    const res = await request(app).get('/v1/admin/dlq');

    expect(res.status).toBe(401);
  });

  it('forbids authenticated non-admin users', async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    const user = await createUser(UserRole.USER);

    const res = await request(app)
      .get('/v1/admin/dlq')
      .set('Authorization', `Bearer ${signToken(user._id.toString())}`);

    expect(res.status).toBe(403);
  });
});

// ─── POST /v1/admin/dlq/:id/retry ──────────────────────────────────────────────

describe('POST /v1/admin/dlq/:id/retry', () => {
  it('resolves the entry when the Stellar retry succeeds', async () => {
    const token = await adminToken();
    const entry = await createEntry();
    submitEscrowLock.mockResolvedValueOnce({ transactionHash: 'abc123' });

    const res = await request(app)
      .post(`/v1/admin/dlq/${entry._id}/retry`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual({ transactionHash: 'abc123' });
    expect(submitEscrowLock).toHaveBeenCalledWith(entry.payload);

    const reloaded = await DlqEntry.findById(entry._id);
    expect(reloaded?.status).toBe(DlqStatus.RESOLVED);
    expect(reloaded?.retryCount).toBe(1);
  });

  it('keeps the entry pending and increments retryCount when the retry fails', async () => {
    const token = await adminToken();
    const entry = await createEntry({ retryCount: 1 });
    submitEscrowLock.mockRejectedValueOnce(new Error('horizon unavailable'));

    const res = await request(app)
      .post(`/v1/admin/dlq/${entry._id}/retry`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toContain('Retry failed: horizon unavailable');

    const reloaded = await DlqEntry.findById(entry._id);
    expect(reloaded?.status).toBe(DlqStatus.PENDING);
    expect(reloaded?.retryCount).toBe(2);
    expect(reloaded?.errorReason).toBe('horizon unavailable');
  });

  it('accumulates retryCount across repeated failures', async () => {
    const token = await adminToken();
    const entry = await createEntry();
    submitEscrowLock.mockRejectedValue(new Error('still failing'));

    await request(app)
      .post(`/v1/admin/dlq/${entry._id}/retry`)
      .set('Authorization', `Bearer ${token}`);
    await request(app)
      .post(`/v1/admin/dlq/${entry._id}/retry`)
      .set('Authorization', `Bearer ${token}`);

    const reloaded = await DlqEntry.findById(entry._id);
    expect(reloaded?.retryCount).toBe(2);
    expect(reloaded?.status).toBe(DlqStatus.PENDING);
  });

  it('rejects retrying an entry that is already resolved', async () => {
    const token = await adminToken();
    const entry = await createEntry({ status: DlqStatus.RESOLVED });

    const res = await request(app)
      .post(`/v1/admin/dlq/${entry._id}/retry`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(submitEscrowLock).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown entry id', async () => {
    const token = await adminToken();

    const res = await request(app)
      .post(`/v1/admin/dlq/${new mongoose.Types.ObjectId().toString()}/retry`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(submitEscrowLock).not.toHaveBeenCalled();
  });

  it('forbids authenticated non-admin users', async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    const user = await createUser(UserRole.USER);
    const entry = await createEntry();

    const res = await request(app)
      .post(`/v1/admin/dlq/${entry._id}/retry`)
      .set('Authorization', `Bearer ${signToken(user._id.toString())}`);

    expect(res.status).toBe(403);
    expect(submitEscrowLock).not.toHaveBeenCalled();
  });
});
