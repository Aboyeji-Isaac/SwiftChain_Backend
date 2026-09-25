import request from 'supertest';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import User from '../src/models/User';
import Dispute, { DisputeReason, DisputeStatus } from '../src/models/Dispute';
import { UserRole, UserStatus } from '../src/interfaces/IUser';

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

// ─── In-memory MongoDB ─────────────────────────────────────────────────────────

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
  if (mongoServer) {
    await mongoServer.stop();
  }
}, 15_000);

// ─── Helpers ───────────────────────────────────────────────────────────────────

const JWT_SECRET = 'test-secret-key-16chars';

/** Mint a signed JWT for the given user id. */
const signToken = (userId: string): string =>
  jwt.sign({ id: userId }, JWT_SECRET, { expiresIn: '1h' });

/** Create a User document directly. */
const createUser = async (
  overrides: Partial<{
    firstName: string;
    lastName: string;
    email: string;
    password: string;
    role: UserRole;
    status: UserStatus;
  }> = {},
) => {
  return User.create({
    firstName: overrides.firstName ?? 'Test',
    lastName: overrides.lastName ?? 'User',
    email: overrides.email ?? `user-${Date.now()}-${Math.random()}@example.com`,
    password: overrides.password ?? 'Password123!',
    role: overrides.role ?? UserRole.USER,
    status: overrides.status ?? UserStatus.ACTIVE,
  });
};

/** Create a Dispute document directly. */
const createDispute = async (
  overrides: Partial<{
    deliveryId: string;
    raisedBy: string;
    reason: DisputeReason;
    description: string;
    status: DisputeStatus;
  }> = {},
) => {
  return Dispute.create({
    deliveryId: overrides.deliveryId ?? new mongoose.Types.ObjectId().toString(),
    raisedBy: overrides.raisedBy ?? new mongoose.Types.ObjectId().toString(),
    reason: overrides.reason ?? DisputeReason.DAMAGED_PACKAGE,
    description: overrides.description ?? 'Package was damaged upon arrival.',
    status: overrides.status ?? DisputeStatus.OPEN,
  });
};

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/disputes', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = JWT_SECRET;
  });

  describe('200 Happy Path & Filtering', () => {
    it('returns active disputes (OPEN and UNDER_REVIEW) by default when status is omitted', async () => {
      const admin = await createUser({ role: UserRole.ADMIN });
      const token = signToken(admin._id.toString());

      // Create disputes in various statuses
      await createDispute({ status: DisputeStatus.OPEN, description: 'Dispute 1 Open' });
      await createDispute({ status: DisputeStatus.UNDER_REVIEW, description: 'Dispute 2 Review' });
      await createDispute({ status: DisputeStatus.RESOLVED, description: 'Dispute 3 Resolved' });
      await createDispute({ status: DisputeStatus.REJECTED, description: 'Dispute 4 Rejected' });

      const res = await request(app)
        .get('/api/v1/admin/disputes')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.pagination).toEqual({
        total: 2,
        page: 1,
        limit: 10,
        totalPages: 1,
      });

      const statuses = res.body.data.map((d: { status: string }) => d.status);
      expect(statuses).toContain(DisputeStatus.OPEN);
      expect(statuses).toContain(DisputeStatus.UNDER_REVIEW);
      expect(statuses).not.toContain(DisputeStatus.RESOLVED);
      expect(statuses).not.toContain(DisputeStatus.REJECTED);
    });

    it('filters disputes by specific status (status=resolved)', async () => {
      const admin = await createUser({ role: UserRole.ADMIN });
      const token = signToken(admin._id.toString());

      await createDispute({ status: DisputeStatus.OPEN });
      await createDispute({ status: DisputeStatus.RESOLVED, description: 'Resolved 1' });
      await createDispute({ status: DisputeStatus.RESOLVED, description: 'Resolved 2' });

      const res = await request(app)
        .get('/api/v1/admin/disputes?status=resolved')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.data[0].status).toBe(DisputeStatus.RESOLVED);
      expect(res.body.data[1].status).toBe(DisputeStatus.RESOLVED);
    });

    it('filters disputes by status=all to include all statuses', async () => {
      const admin = await createUser({ role: UserRole.ADMIN });
      const token = signToken(admin._id.toString());

      await createDispute({ status: DisputeStatus.OPEN });
      await createDispute({ status: DisputeStatus.UNDER_REVIEW });
      await createDispute({ status: DisputeStatus.RESOLVED });
      await createDispute({ status: DisputeStatus.REJECTED });

      const res = await request(app)
        .get('/api/v1/admin/disputes?status=all')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(4);
      expect(res.body.pagination.total).toBe(4);
    });

    it('supports custom pagination (page=2, limit=2)', async () => {
      const admin = await createUser({ role: UserRole.ADMIN });
      const token = signToken(admin._id.toString());

      for (let i = 1; i <= 5; i++) {
        await createDispute({ status: DisputeStatus.OPEN, description: `Dispute #${i}` });
      }

      const res = await request(app)
        .get('/api/v1/admin/disputes?page=2&limit=2')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.pagination).toEqual({
        total: 5,
        page: 2,
        limit: 2,
        totalPages: 3,
      });
    });
  });

  describe('400 Bad Request & Validation Errors', () => {
    it('returns 400 for invalid dispute status', async () => {
      const admin = await createUser({ role: UserRole.ADMIN });
      const token = signToken(admin._id.toString());

      const res = await request(app)
        .get('/api/v1/admin/disputes?status=invalid_status')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid dispute status');
    });

    it('returns 400 for non-integer or negative page parameter', async () => {
      const admin = await createUser({ role: UserRole.ADMIN });
      const token = signToken(admin._id.toString());

      const res = await request(app)
        .get('/api/v1/admin/disputes?page=-1')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Page must be a positive integer.');
    });

    it('returns 400 for non-integer or zero limit parameter', async () => {
      const admin = await createUser({ role: UserRole.ADMIN });
      const token = signToken(admin._id.toString());

      const res = await request(app)
        .get('/api/v1/admin/disputes?limit=abc')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Limit must be a positive integer.');
    });
  });

  describe('401 Unauthorized & 403 Forbidden', () => {
    it('returns 401 when Authorization header is missing', async () => {
      const res = await request(app).get('/api/v1/admin/disputes');

      expect(res.status).toBe(401);
    });

    it('returns 403 when a non-admin user attempts to access the endpoint', async () => {
      const regularUser = await createUser({ role: UserRole.USER });
      const token = signToken(regularUser._id.toString());

      const res = await request(app)
        .get('/api/v1/admin/disputes')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
    });
  });
});
