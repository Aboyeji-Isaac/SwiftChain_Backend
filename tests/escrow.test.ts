import request from 'supertest';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import User from '../src/models/User';
import Escrow, { EscrowStatus } from '../src/models/Escrow';
import { UserRole, UserStatus } from '../src/interfaces/IUser';
import { escrowService } from '../src/services/escrow.service';

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

jest.mock('../src/blockchain/soroban.service', () => ({
  sorobanService: {
    getLatestLedger: jest.fn().mockResolvedValue(999999),
  },
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
  await mongoServer.stop();
}, 15_000);

// ─── Helpers ───────────────────────────────────────────────────────────────────

const JWT_SECRET = 'test-secret-key-16chars';

const signToken = (userId: string): string => jwt.sign({ userId }, JWT_SECRET, { expiresIn: '1h' });

const createUser = async (
  overrides: Partial<{ role: UserRole; status: UserStatus }> = {},
): Promise<InstanceType<typeof User>> => {
  return User.create({
    firstName: 'Test',
    lastName: 'User',
    email: `user-${Date.now()}-${Math.random()}@example.com`,
    password: 'Password123!',
    role: overrides.role ?? UserRole.USER,
    status: overrides.status ?? UserStatus.ACTIVE,
  });
};

/** Creates an escrow record with a lock period that has already expired. */
const createExpiredEscrow = async (overrides: Partial<{ amount: number }> = {}) => {
  return Escrow.create({
    delivery: new mongoose.Types.ObjectId(),
    amount: overrides.amount ?? 100,
    assetCode: 'XLM',
    lockedAt: new Date(Date.now() - 10 * 60 * 1000),
    expiresAt: new Date(Date.now() - 60 * 1000),
    status: EscrowStatus.LOCKED,
  });
};

/** Creates an escrow record whose TTL has not yet elapsed. */
const createActiveEscrow = async () => {
  return Escrow.create({
    delivery: new mongoose.Types.ObjectId(),
    amount: 100,
    assetCode: 'XLM',
    lockedAt: new Date(),
    expiresAt: new Date(Date.now() + 3600 * 1000),
    status: EscrowStatus.LOCKED,
  });
};

// ─── scanForExpiredEscrows (service / job logic) ───────────────────────────────

describe('scanForExpiredEscrows', () => {
  it('flags escrows whose lock duration has exceeded their TTL', async () => {
    const expired = await createExpiredEscrow();
    const active = await createActiveEscrow();

    const result = await escrowService.scanForExpiredEscrows();

    expect(result.flaggedCount).toBe(1);

    const refreshedExpired = await Escrow.findById(expired._id);
    expect(refreshedExpired?.status).toBe(EscrowStatus.EXPIRED);
    expect(refreshedExpired?.flaggedAt).toBeDefined();
    expect(refreshedExpired?.flaggedLedger).toBe(999999);

    const refreshedActive = await Escrow.findById(active._id);
    expect(refreshedActive?.status).toBe(EscrowStatus.LOCKED);
  });

  it('is a no-op when no escrows have expired', async () => {
    await createActiveEscrow();

    const result = await escrowService.scanForExpiredEscrows();

    expect(result.flaggedCount).toBe(0);
    expect(result.flaggedEscrows).toHaveLength(0);
  });

  it('does not re-flag escrows that are already expired', async () => {
    const expired = await createExpiredEscrow();
    await escrowService.scanForExpiredEscrows();

    const result = await escrowService.scanForExpiredEscrows();

    expect(result.flaggedCount).toBe(0);
    const refreshed = await Escrow.findById(expired._id);
    expect(refreshed?.status).toBe(EscrowStatus.EXPIRED);
  });
});

// ─── GET /api/v1/admin/escrows/flagged ─────────────────────────────────────────

describe('GET /api/v1/admin/escrows/flagged', () => {
  it('returns flagged (expired) escrows for an admin', async () => {
    process.env.JWT_SECRET = JWT_SECRET;

    await createExpiredEscrow();
    await escrowService.scanForExpiredEscrows();

    const admin = await createUser({ role: UserRole.ADMIN });
    const token = signToken(admin._id.toString());

    const res = await request(app)
      .get('/api/v1/admin/escrows/flagged')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.escrows).toHaveLength(1);
    expect(res.body.data.escrows[0].status).toBe('expired');
    expect(res.body.data.total).toBe(1);
  });

  it('does not include escrows that have not expired', async () => {
    process.env.JWT_SECRET = JWT_SECRET;

    await createActiveEscrow();

    const admin = await createUser({ role: UserRole.ADMIN });
    const token = signToken(admin._id.toString());

    const res = await request(app)
      .get('/api/v1/admin/escrows/flagged')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.escrows).toHaveLength(0);
  });

  it('returns 403 when a non-admin calls the endpoint', async () => {
    process.env.JWT_SECRET = JWT_SECRET;

    const user = await createUser({ role: UserRole.USER });
    const token = signToken(user._id.toString());

    const res = await request(app)
      .get('/api/v1/admin/escrows/flagged')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  it('returns 401 when no Authorization header is provided', async () => {
    const res = await request(app).get('/api/v1/admin/escrows/flagged');
    expect(res.status).toBe(401);
  });
});

// ─── PATCH /api/v1/admin/escrows/:id/resolve ───────────────────────────────────

describe('PATCH /api/v1/admin/escrows/:id/resolve', () => {
  it('resolves a flagged escrow', async () => {
    process.env.JWT_SECRET = JWT_SECRET;

    const expired = await createExpiredEscrow();
    await escrowService.scanForExpiredEscrows();

    const admin = await createUser({ role: UserRole.ADMIN });
    const token = signToken(admin._id.toString());

    const res = await request(app)
      .patch(`/api/v1/admin/escrows/${expired._id}/resolve`)
      .set('Authorization', `Bearer ${token}`)
      .send({ notes: 'Manually released funds to the customer.' });

    expect(res.status).toBe(200);
    expect(res.body.data.escrow.status).toBe('resolved');

    const refreshed = await Escrow.findById(expired._id);
    expect(refreshed?.status).toBe(EscrowStatus.RESOLVED);
    expect(refreshed?.resolvedBy).toBe(admin._id.toString());
  });

  it('returns 400 when notes are missing', async () => {
    process.env.JWT_SECRET = JWT_SECRET;

    const expired = await createExpiredEscrow();
    await escrowService.scanForExpiredEscrows();

    const admin = await createUser({ role: UserRole.ADMIN });
    const token = signToken(admin._id.toString());

    const res = await request(app)
      .patch(`/api/v1/admin/escrows/${expired._id}/resolve`)
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(400);
  });

  it('returns 409 when the escrow is not in the expired state', async () => {
    process.env.JWT_SECRET = JWT_SECRET;

    const active = await createActiveEscrow();

    const admin = await createUser({ role: UserRole.ADMIN });
    const token = signToken(admin._id.toString());

    const res = await request(app)
      .patch(`/api/v1/admin/escrows/${active._id}/resolve`)
      .set('Authorization', `Bearer ${token}`)
      .send({ notes: 'Attempting early resolution.' });

    expect(res.status).toBe(409);
  });

  it('returns 404 when the escrow does not exist', async () => {
    process.env.JWT_SECRET = JWT_SECRET;

    const admin = await createUser({ role: UserRole.ADMIN });
    const token = signToken(admin._id.toString());
    const nonExistentId = new mongoose.Types.ObjectId().toString();

    const res = await request(app)
      .patch(`/api/v1/admin/escrows/${nonExistentId}/resolve`)
      .set('Authorization', `Bearer ${token}`)
      .send({ notes: 'Test.' });

    expect(res.status).toBe(404);
  });
});
