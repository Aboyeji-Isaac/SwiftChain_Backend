/**
 * Integration tests: shared query contract across list endpoints (issue #221).
 *
 * Every migrated list endpoint must accept `page`, `limit`, `sort` and
 * whitelisted filters, and return the exact same pagination meta structure
 * built by `buildPaginationMeta` (see docs/query-contract.md).
 *
 * Real MongoDB via MongoMemoryServer; the app is booted via supertest so the
 * actual middleware chain (auth → role → buildQueryOptions → controller) runs.
 */

import request from 'supertest';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Express } from 'express';

import { Delivery } from '../../src/models/Delivery';
import User from '../../src/models/User';
import Dispute from '../../src/models/Dispute';
import Fleet from '../../src/models/Fleet';
import Notification from '../../src/models/Notification';
import { WebhookSubscription } from '../../src/models/WebhookSubscription';
import EventLog from '../../src/models/EventLog';
import { NotificationStatus } from '../../src/models/Notification';
import { DisputeStatus, DisputeReason } from '../../src/models/Dispute';
import { UserRole } from '../../src/interfaces/IUser';
import env from '../../src/config/env';

jest.mock('../../src/config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../../src/config/database', () => ({
  connectDatabase: jest.fn(),
}));

/** The meta shape every list endpoint must return. */
const META_KEYS = [
  'totalItems',
  'totalPages',
  'currentPage',
  'limit',
  'hasNextPage',
  'hasPreviousPage',
  'nextPage',
  'previousPage',
] as const;

let app: Express;
let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongoServer.getUri();

  const mod = await import('../../src/app');
  app = mod.default;
  await mongoose.connect(mongoServer.getUri());
});

afterEach(async () => {
  const collections = mongoose.connection.collections;
  for (const key of Object.keys(collections)) {
    await collections[key].deleteMany({});
  }
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

// ─── Auth helpers ─────────────────────────────────────────────────────────────

/**
 * Sign a token the way the app expects. `authenticate` loads the User from
 * the database by `userId`, so tests must create real users first; routes
 * guarded by the JWT-only `authMiddleware` additionally read `role` from the
 * token payload. Tokens are signed with the already-parsed `env.JWT_SECRET`
 * so they verify no matter what secret the runner provided.
 */
const signToken = (userId: string, role?: string): string =>
  jwt.sign(role ? { userId, role } : { userId }, env.JWT_SECRET, { expiresIn: '1h' });

let userSeq = 0;

const createUser = async (role: UserRole): Promise<InstanceType<typeof User>> =>
  User.create({
    email: `qc-${role}-${++userSeq}@swiftchain.test`,
    password: 'SecretPass123!',
    firstName: 'QC',
    lastName: role,
    role,
    status: 'active',
  });

/** Valid 56-char Stellar address; the suffix keeps fleets below the unique index. */
const treasury = (i: number): string => `G${'A'.repeat(51)}${String(i).padStart(4, '0')}`;

/** Assert a pagination payload carries the exact shared meta contract. */
function expectSharedMeta(meta: unknown): void {
  expect(meta).toBeDefined();
  META_KEYS.forEach((key) => {
    expect(meta).toHaveProperty(key);
  });
}

// ─── Deliveries ───────────────────────────────────────────────────────────────

describe('GET /api/v1/deliveries', () => {
  it('applies page/limit and returns the shared meta', async () => {
    for (let i = 0; i < 5; i++) {
      await Delivery.create({
        trackingNumber: `QC-00${i}`,
        customer: { name: 'QC Customer', phone: '+1000000000' },
        pickup: { address: 'a', city: 'c' },
        dropoff: { address: 'b', city: 'c' },
        package: { description: 'box', weight: 1 },
        status: 'pending',
      });
    }

    const res = await request(app).get('/api/v1/deliveries?page=2&limit=2');

    expect(res.status).toBe(200);
    expect(res.body.data.deliveries).toHaveLength(2);
    expectSharedMeta(res.body.data.meta);
    expect(res.body.data.meta).toMatchObject({
      totalItems: 5,
      totalPages: 3,
      currentPage: 2,
      limit: 2,
      hasNextPage: true,
      hasPreviousPage: true,
      nextPage: 3,
      previousPage: 1,
    });

    const last = await request(app).get('/api/v1/deliveries?page=3&limit=2');
    expect(last.status).toBe(200);
    expect(last.body.data.meta).toMatchObject({
      currentPage: 3,
      hasNextPage: false,
      nextPage: null,
      previousPage: 2,
    });
  });

  it('supports whitelisted filters, search and sort, rejecting unknown sort fields', async () => {
    await Delivery.create({
      trackingNumber: 'QC-FILTER',
      customer: { name: 'Filter Me', phone: '+1000000001' },
      pickup: { address: 'a', city: 'c' },
      dropoff: { address: 'b', city: 'c' },
      package: { description: 'box', weight: 1 },
      status: 'pending',
    });
    await Delivery.create({
      trackingNumber: 'QC-OTHER',
      customer: { name: 'Filter Me', phone: '+1000000001' },
      pickup: { address: 'a', city: 'c' },
      dropoff: { address: 'b', city: 'c' },
      package: { description: 'box', weight: 1 },
      status: 'assigned',
    });

    const filtered = await request(app).get('/api/v1/deliveries?status=pending');
    expect(filtered.status).toBe(200);
    expect(filtered.body.data.deliveries).toHaveLength(1);
    expect(filtered.body.data.deliveries[0].status).toBe('pending');

    const searched = await request(app).get('/api/v1/deliveries?search=QC-FILT');
    expect(searched.status).toBe(200);
    expect(searched.body.data.deliveries).toHaveLength(1);

    const sorted = await request(app).get('/api/v1/deliveries?sort=-createdAt&limit=1');
    expect(sorted.status).toBe(200);
    expectSharedMeta(sorted.body.data.meta);

    const badSort = await request(app).get('/api/v1/deliveries?sort=notAField');
    expect(badSort.status).toBe(400);

    const badPage = await request(app).get('/api/v1/deliveries?page=0');
    expect(badPage.status).toBe(400);
  });
});

// ─── Disputes (admin-only list) ───────────────────────────────────────────────

describe('GET /api/v1/disputes', () => {
  it('paginates, filters and returns the shared meta', async () => {
    const admin = await createUser(UserRole.ADMIN);

    for (let i = 0; i < 3; i++) {
      await Dispute.create({
        disputeId: `qcd-${i}`,
        deliveryId: `qd-${i}`,
        openedBy: 'GABC',
        raisedBy: 'GABC',
        reason: DisputeReason.OTHER,
        description: 'QC dispute',
        status: DisputeStatus.OPEN,
        openedLedger: 10 + i,
      });
    }

    const res = await request(app)
      .get('/api/v1/disputes?page=1&limit=2&status=open')
      .set('Authorization', `Bearer ${signToken(admin._id.toString())}`);

    expect(res.status).toBe(200);
    expect(res.body.data.disputes).toHaveLength(2);
    expectSharedMeta(res.body.data.meta);
    expect(res.body.data.meta).toMatchObject({ totalItems: 3, totalPages: 2, currentPage: 1 });
  });

  it('rejects a non-whitelisted filter operator', async () => {
    const admin = await createUser(UserRole.ADMIN);

    const res = await request(app)
      .get('/api/v1/disputes?status[regex]=open')
      .set('Authorization', `Bearer ${signToken(admin._id.toString())}`);

    expect(res.status).toBe(400);
  });
});

// ─── Users (admin-only deleted list) ──────────────────────────────────────────

describe('GET /api/v1/users/deleted', () => {
  it('paginates soft-deleted users with the shared meta', async () => {
    // This route uses the JWT-only authMiddleware, so the role must travel
    // inside the token payload rather than being loaded from the database.
    const admin = await createUser(UserRole.ADMIN);

    for (let i = 0; i < 3; i++) {
      await User.create({
        email: `qc-del-${i}-${userSeq}@swiftchain.test`,
        password: 'SecretPass123!',
        firstName: 'QC',
        lastName: `Deleted${i}`,
        role: 'user',
        status: 'active',
        isDeleted: true,
        deletedAt: new Date(),
      });
    }

    const res = await request(app)
      .get('/api/v1/users/deleted?page=1&limit=2')
      .set('Authorization', `Bearer ${signToken(admin._id.toString(), UserRole.ADMIN)}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    // The users list keeps its legacy top-level `pagination` key.
    expectSharedMeta(res.body.pagination);
    expect(res.body.pagination).toMatchObject({ totalItems: 3, totalPages: 2, limit: 2 });
  });
});

// ─── Fleets ───────────────────────────────────────────────────────────────────

describe('GET /api/v1/fleets', () => {
  it('returns the shared meta instead of the legacy `pages` key', async () => {
    const owner = await createUser(UserRole.ENTERPRISE);

    for (let i = 0; i < 2; i++) {
      await Fleet.create({
        name: `QC Fleet ${i}`,
        treasuryAddress: treasury(i),
        ownerId: owner._id,
        members: [],
        businessMetadata: {
          companyName: 'QC Logistics',
          contactEmail: 'fleet@qc.test',
        },
        isActive: true,
      });
    }

    const res = await request(app)
      .get('/api/v1/fleets?limit=1&search=Fleet')
      .set('Authorization', `Bearer ${signToken(owner._id.toString())}`);

    expect(res.status).toBe(200);
    expect(res.body.data.fleets).toHaveLength(1);
    expectSharedMeta(res.body.data.meta);
    expect(res.body.data.meta).toMatchObject({ totalItems: 2, totalPages: 2 });
    expect(res.body.data.meta).not.toHaveProperty('pages');
  });
});

// ─── Notifications ────────────────────────────────────────────────────────────

describe('GET /api/v1/notifications', () => {
  it('paginates the user-scoped history with the shared meta', async () => {
    const user = await createUser(UserRole.USER);

    for (let i = 0; i < 3; i++) {
      await Notification.create({
        user: user._id,
        event: 'delivery.assigned',
        channel: 'push',
        title: `QC ${i}`,
        body: 'QC body',
        data: {},
        status: NotificationStatus.SENT,
        acceptedCount: 1,
        rejectedCount: 0,
      });
    }

    const res = await request(app)
      .get('/api/v1/notifications?page=2&limit=2&status=sent')
      .set('Authorization', `Bearer ${signToken(user._id.toString())}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expectSharedMeta(res.body.meta);
    expect(res.body.meta).toMatchObject({ totalItems: 3, totalPages: 2, currentPage: 2 });
  });
});

// ─── Webhooks ─────────────────────────────────────────────────────────────────

describe('GET /api/v1/webhooks', () => {
  it('paginates merchant webhooks and returns the shared meta', async () => {
    const merchant = await createUser(UserRole.ENTERPRISE);

    for (let i = 0; i < 2; i++) {
      await WebhookSubscription.create({
        merchantId: merchant._id,
        url: `https://example.com/hook-${i}`,
        secret: 's3cret-value',
        events: ['delivery.assigned'],
        isActive: true,
      });
    }

    const res = await request(app)
      .get('/api/v1/webhooks?limit=1&isActive=true')
      .set('Authorization', `Bearer ${signToken(merchant._id.toString())}`);

    expect(res.status).toBe(200);
    expect(res.body.data.webhooks).toHaveLength(1);
    expectSharedMeta(res.body.data.meta);
    expect(res.body.data.meta).toMatchObject({ totalItems: 2, totalPages: 2 });
  });
});

// ─── Event log ────────────────────────────────────────────────────────────────

describe('GET /api/v1/eventlog/unprocessed', () => {
  it('paginates pending events and returns the shared meta', async () => {
    const admin = await createUser(UserRole.ADMIN);

    for (let i = 0; i < 3; i++) {
      await EventLog.create({
        eventType: 'delivery',
        transactionHash: `0xqc${i}${'0'.repeat(56)}`,
        ledgerSequence: 1000 + i,
        contractId: 'CQC',
        eventData: { amount: 1 },
        status: 'pending',
      });
    }

    const res = await request(app)
      .get('/api/v1/eventlog/unprocessed?limit=2')
      .set('Authorization', `Bearer ${signToken(admin._id.toString())}`);

    expect(res.status).toBe(200);
    expect(res.body.data.events).toHaveLength(2);
    expectSharedMeta(res.body.data.meta);
    expect(res.body.data.meta).toMatchObject({ totalItems: 3, totalPages: 2 });
  });
});
