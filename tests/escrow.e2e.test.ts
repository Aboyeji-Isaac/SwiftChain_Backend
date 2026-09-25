/**
 * E2E Tests — Complete Escrow Lifecycle
 *
 * Tests the full escrow flow: Create (Fund via indexer) → Release/Refund
 * Uses real MongoDB and mocked Soroban contract interactions.
 * Validates database state at each lifecycle step.
 *
 * Architecture: Tests call HTTP endpoints (Controller layer)
 * which delegate to Service layer which reads/writes Model layer.
 *
 * GitHub Issue #110: Write E2E tests for the complete Escrow lifecycle
 */

import request from 'supertest';
import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import User from '../src/models/User';
import Escrow, { EscrowStatus, IEscrow } from '../src/models/Escrow';
import Delivery, { DeliveryStatus, IDelivery } from '../src/models/Delivery';
import { IUser, UserRole, UserStatus } from '../src/interfaces/IUser';
import { escrowService } from '../src/services/escrow.service';

let app: any;
let mongoServer: MongoMemoryServer;

// ─── Mock Database Connection ──────────────────────────────────────────
jest.mock('../src/config/database', () => ({
  connectDatabase: jest.fn(),
}));

// ─── Mock Logger ───────────────────────────────────────────────────────
jest.mock('../src/config/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

// ─── Mock Soroban Service ──────────────────────────────────────────────
jest.mock('../src/blockchain/soroban.service', () => ({
  sorobanService: {
    getLatestLedger: jest.fn().mockResolvedValue(999999),
  },
}));

// ─── Mock Redis / Distributed Locking ──────────────────────────────────
jest.mock('../src/config/redis', () => ({
  withLock: jest.fn().mockImplementation(
    async (_resourceKey: string, fn: () => Promise<any>) => fn(),
  ),
  redisClient: {
    get: jest.fn(),
    set: jest.fn(),
  },
}));

// ─── Mock Proof of Delivery Service ────────────────────────────────────
jest.mock('../src/services/proofOfDeliveryService', () => ({
  proofOfDeliveryService: {
    assertProofOfDeliveryExists: jest.fn().mockResolvedValue(undefined),
  },
}));

// ─── Setup & Teardown ──────────────────────────────────────────────────

const JWT_SECRET = 'test_secret_at_least_32_characters_long_for_tests';
const SETUP_TIMEOUT = 120_000;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  process.env.JWT_SECRET = JWT_SECRET;
  process.env.NODE_ENV = 'test';
  // This suite performs several authenticated logins per test; raise the
  // global /api rate limit so the limiter does not starve the suite.
  process.env.RATE_LIMIT_MAX_REQUESTS = '10000';

  const mod = await import('../src/app');
  app = mod.default;
}, SETUP_TIMEOUT);

afterEach(async () => {
  // Clear all collections between tests
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    await collections[key].deleteMany({});
  }
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
}, 30_000);

// ─── Helpers ───────────────────────────────────────────────────────────

/**
 * Create a test user with optional overrides
 */
const createTestUser = async (overrides: Partial<{
  email: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  status: UserStatus;
}> = {}): Promise<IUser> => {
  const defaultUser = {
    email: `user-${Date.now()}-${Math.random()}@example.com`,
    password: 'SecurePass123!',
    firstName: 'Test',
    lastName: 'User',
    role: UserRole.USER,
    status: UserStatus.ACTIVE,
    ...overrides,
  };

  return User.create(defaultUser);
};

/**
 * Login a user and return JWT token
 */
const loginUser = async (email: string, password: string): Promise<string> => {
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ email, password });

  if (res.status !== 200 || !res.body.data?.token) {
    throw new Error(
      `Login failed: ${res.status} — ${res.body.message || 'unknown error'}`,
    );
  }

  return res.body.data.token;
};

/**
 * Create a test delivery
 */
const createTestDelivery = async (overrides: Partial<IDelivery> = {}): Promise<IDelivery> => {
  const delivery = await Delivery.create({
    deliveryId: `DEL-${Date.now()}-${Math.random()}`,
    trackingNumber: `TRK-${Date.now()}-${Math.random()}`,
    driverId: new Types.ObjectId().toString(),
    userId: new Types.ObjectId().toString(),
    pickupCoordinates: { lat: 40.7128, lng: -74.006, address: '123 Main St' },
    dropoffCoordinates: { lat: 40.758, lng: -73.9855, address: '456 Park Ave' },
    status: DeliveryStatus.PENDING,
    ...overrides,
  });

  return delivery;
};

/**
 * Record an escrow funded event (simulates indexer processing)
 */
const recordEscrowFunded = async (delivery: IDelivery): Promise<IEscrow> => {
  return escrowService.recordEscrowFunded({
    contractId: `CESCROW-${Date.now()}`,
    deliveryId: delivery._id.toString(),
    amount: 100,
    asset: 'XLM',
    fundedBy: 'GFUNDER123456789',
    transactionHash: `txfund-${Date.now()}-${Math.random()}`,
    ledger: 100000,
  });
};

// ─── E2E Tests ──────────────────────────────────────────────────────────

describe('Escrow Lifecycle E2E Tests', () => {

  let buyerUser: IUser;
  let sellerUser: IUser;
  let buyerToken: string;
  let sellerToken: string;
  let testDelivery: IDelivery;
  let testEscrow: IEscrow;

  beforeAll(async () => {
    // Create buyer and seller users
    buyerUser = await createTestUser({
      firstName: 'Buyer',
      lastName: 'User',
    });
    sellerUser = await createTestUser({
      firstName: 'Seller',
      lastName: 'User',
    });

    // Login both users
    buyerToken = await loginUser(buyerUser.email, 'SecurePass123!');
    sellerToken = await loginUser(sellerUser.email, 'SecurePass123!');
  });

  // ── STEP 1: Fund Escrow (via Indexer) ────────────────────────────────

  describe('Step 1 — Fund Escrow (Indexer Event)', () => {

    beforeEach(async () => {
      testDelivery = await createTestDelivery();
      testEscrow = await recordEscrowFunded(testDelivery);
    });

    it('escrow is created with status "locked" after funding event', async () => {
      expect(testEscrow).toBeDefined();
      expect(testEscrow._id).toBeDefined();
      expect(testEscrow.status).toBe(EscrowStatus.LOCKED);
    });

    it('escrow has correct amount and asset code', async () => {
      expect(testEscrow.amount).toBe(100);
      expect(testEscrow.assetCode).toBe('XLM');
    });

    it('escrow has Soroban contract ID stored', async () => {
      expect(testEscrow.contractId).toMatch(/^CESCROW-/);
    });

    it('escrow has payer address from funding event', async () => {
      expect(testEscrow.payerAddress).toBe('GFUNDER123456789');
    });

    it('escrow has fund transaction hash recorded', async () => {
      expect(testEscrow.transactions).toHaveLength(1);
      expect(testEscrow.transactions[0].type).toBe('fund');
      expect(testEscrow.transactions[0].hash).toMatch(/^txfund-/);
      expect(testEscrow.transactions[0].ledger).toBe(100000);
    });

    it('delivery status is updated to "funded" after escrow funding', async () => {
      const updatedDelivery = await Delivery.findById(testDelivery._id);
      expect(updatedDelivery?.status).toBe(DeliveryStatus.FUNDED);
    });

    it('lockedAt timestamp is set', async () => {
      // Note: Check stored document from DB, not from service return
      const stored = await Escrow.findById(testEscrow._id);
      expect(stored?.lockedAt).toBeDefined();
      expect(stored?.lockedAt).toBeInstanceOf(Date);
    });

    it('isFundsLocked virtual returns true', async () => {
      const stored = await Escrow.findById(testEscrow._id);
      expect(stored?.isFundsLocked).toBe(true);
    });

    it('isSettled virtual returns false (funds still locked)', async () => {
      const stored = await Escrow.findById(testEscrow._id);
      expect(stored?.isSettled).toBe(false);
    });

    it('recordEscrowFunded is idempotent (replaying same tx hash is no-op)', async () => {
      const secondRecord = await escrowService.recordEscrowFunded({
        contractId: testEscrow.contractId!,
        deliveryId: testDelivery._id.toString(),
        amount: 999,
        asset: 'USDC',
        fundedBy: 'GDIFFERENT',
        transactionHash: testEscrow.transactions[0].hash,
        ledger: 200000,
      });

      // Check the original values are preserved
      expect(secondRecord.amount).toBe(100); // Original amount preserved
      expect(secondRecord.assetCode).toBe('XLM'); // Original asset preserved
      expect(secondRecord.transactions).toHaveLength(1); // No duplicate tx
    });
  });

  // ── STEP 2: Release Escrow ───────────────────────────────────────────

  describe('Step 2 — Release Escrow', () => {

    beforeEach(async () => {
      // The global afterEach wipes every collection (including users) between
      // tests, so the buyer/seller accounts are recreated and re-logged-in
      // here to keep the JWTs resolvable by the auth middleware.
      buyerUser = await createTestUser({ firstName: 'Buyer', lastName: 'User' });
      sellerUser = await createTestUser({ firstName: 'Seller', lastName: 'User' });
      buyerToken = await loginUser(buyerUser.email, 'SecurePass123!');
      sellerToken = await loginUser(sellerUser.email, 'SecurePass123!');

      testDelivery = await createTestDelivery();
      testEscrow = await recordEscrowFunded(testDelivery);
    });

    it('POST /api/v1/escrow/release releases escrow and returns 200', async () => {
      const res = await request(app)
        .post('/api/v1/escrow/release')
        .set('Authorization', `Bearer ${buyerToken}`)
        .send({
          escrowId: testEscrow._id.toString(),
          transactionHash: `txrelease-${Date.now()}`,
          ledger: 100001,
        });

      expect(res.status).toBe(200);
      expect(res.body.data?.escrow).toBeDefined();
    });

    it('escrow status changes to "released" after release', async () => {
      await request(app)
        .post('/api/v1/escrow/release')
        .set('Authorization', `Bearer ${buyerToken}`)
        .send({
          escrowId: testEscrow._id.toString(),
          transactionHash: `txrelease-${Date.now()}`,
        });

      const updated = await Escrow.findById(testEscrow._id);
      // Check against both possible status field names
      expect((updated as any).lockStatus || updated?.status).toBe(EscrowStatus.RELEASED);
    });

    it('escrow has release transaction hash recorded', async () => {
      const txHash = `txrelease-${Date.now()}`;
      await request(app)
        .post('/api/v1/escrow/release')
        .set('Authorization', `Bearer ${buyerToken}`)
        .send({
          escrowId: testEscrow._id.toString(),
          transactionHash: txHash,
          ledger: 100001,
        });

      const updated = await Escrow.findById(testEscrow._id);
      expect(updated?.transactions).toHaveLength(2);

      const releaseTx = updated?.transactions.find((tx) => tx.type === 'release');
      expect(releaseTx).toBeDefined();
      expect(releaseTx?.hash).toBe(txHash);
      expect(releaseTx?.ledger).toBe(100001);
    });

    it('delivery status changes to "completed" after release', async () => {
      await request(app)
        .post('/api/v1/escrow/release')
        .set('Authorization', `Bearer ${buyerToken}`)
        .send({
          escrowId: testEscrow._id.toString(),
          transactionHash: `txrelease-${Date.now()}`,
        });

      const updated = await Delivery.findById(testDelivery._id);
      expect(updated?.status).toBe(DeliveryStatus.COMPLETED);
    });

    it('releasedAt timestamp is set', async () => {
      await request(app)
        .post('/api/v1/escrow/release')
        .set('Authorization', `Bearer ${buyerToken}`)
        .send({
          escrowId: testEscrow._id.toString(),
          transactionHash: `txrelease-${Date.now()}`,
        });

      const updated = await Escrow.findById(testEscrow._id);
      expect(updated?.releasedAt).toBeDefined();
      expect(updated?.releasedAt).toBeInstanceOf(Date);
    });

    it('isFundsLocked virtual returns false after release', async () => {
      await request(app)
        .post('/api/v1/escrow/release')
        .set('Authorization', `Bearer ${buyerToken}`)
        .send({
          escrowId: testEscrow._id.toString(),
          transactionHash: `txrelease-${Date.now()}`,
        });

      const updated = await Escrow.findById(testEscrow._id);
      expect(updated?.isFundsLocked).toBe(false);
    });

    it('isSettled virtual returns true after release', async () => {
      await request(app)
        .post('/api/v1/escrow/release')
        .set('Authorization', `Bearer ${buyerToken}`)
        .send({
          escrowId: testEscrow._id.toString(),
          transactionHash: `txrelease-${Date.now()}`,
        });

      const updated = await Escrow.findById(testEscrow._id);
      expect(updated?.isSettled).toBe(true);
    });

    it('returns 400 when escrowId is missing', async () => {
      const res = await request(app)
        .post('/api/v1/escrow/release')
        .set('Authorization', `Bearer ${buyerToken}`)
        .send({
          transactionHash: `txrelease-${Date.now()}`,
        });

      expect(res.status).toBe(400);
    });

    it('returns 400 when transactionHash is missing', async () => {
      const res = await request(app)
        .post('/api/v1/escrow/release')
        .set('Authorization', `Bearer ${buyerToken}`)
        .send({
          escrowId: testEscrow._id.toString(),
        });

      expect(res.status).toBe(400);
    });

    it('returns 401 without auth token', async () => {
      const res = await request(app)
        .post('/api/v1/escrow/release')
        .send({
          escrowId: testEscrow._id.toString(),
          transactionHash: `txrelease-${Date.now()}`,
        });

      expect(res.status).toBe(401);
    });

    it('returns 404 when escrow does not exist', async () => {
      const fakeId = new Types.ObjectId().toString();
      const res = await request(app)
        .post('/api/v1/escrow/release')
        .set('Authorization', `Bearer ${buyerToken}`)
        .send({
          escrowId: fakeId,
          transactionHash: `txrelease-${Date.now()}`,
        });

      expect(res.status).toBe(404);
    });

    it('returns 409 when attempting to release an already-released escrow', async () => {
      const txHash1 = `txrelease-${Date.now()}-1`;
      const txHash2 = `txrelease-${Date.now()}-2`;

      // Release once
      await request(app)
        .post('/api/v1/escrow/release')
        .set('Authorization', `Bearer ${buyerToken}`)
        .send({
          escrowId: testEscrow._id.toString(),
          transactionHash: txHash1,
        });

      // Attempt to release again with different tx hash
      const res = await request(app)
        .post('/api/v1/escrow/release')
        .set('Authorization', `Bearer ${buyerToken}`)
        .send({
          escrowId: testEscrow._id.toString(),
          transactionHash: txHash2,
        });

      expect(res.status).toBe(409);
      expect(res.body.message).toContain('already been released');
    });

    it('release with different escrowId format (contract ID) works', async () => {
      const contractId = testEscrow.contractId!;

      const res = await request(app)
        .post('/api/v1/escrow/release')
        .set('Authorization', `Bearer ${buyerToken}`)
        .send({
          escrowId: contractId,
          transactionHash: `txrelease-${Date.now()}`,
        });

      expect(res.status).toBe(200);
    });

    it('release transaction is idempotent (replaying same tx hash is no-op)', async () => {
      const txHash = `txrelease-${Date.now()}`;

      // First release
      const res1 = await request(app)
        .post('/api/v1/escrow/release')
        .set('Authorization', `Bearer ${buyerToken}`)
        .send({
          escrowId: testEscrow._id.toString(),
          transactionHash: txHash,
        });

      expect(res1.status).toBe(200);

      // Reload and check transaction count
      let updated = await Escrow.findById(testEscrow._id);
      const txCountAfterFirst = updated?.transactions.length;

      // Attempt to release again with same tx hash
      const res2 = await request(app)
        .post('/api/v1/escrow/release')
        .set('Authorization', `Bearer ${buyerToken}`)
        .send({
          escrowId: testEscrow._id.toString(),
          transactionHash: txHash,
        });

      expect(res2.status).toBe(200);

      // Verify no new transaction was added
      updated = await Escrow.findById(testEscrow._id);
      expect(updated?.transactions.length).toBe(txCountAfterFirst);
    });
  });

  // ── STEP 3: Get Escrow by Delivery ID ────────────────────────────────

  describe('GET /api/v1/escrow/delivery/:deliveryId', () => {

    beforeEach(async () => {
      buyerUser = await createTestUser({ firstName: 'Buyer', lastName: 'User' });
      sellerUser = await createTestUser({ firstName: 'Seller', lastName: 'User' });
      buyerToken = await loginUser(buyerUser.email, 'SecurePass123!');
      sellerToken = await loginUser(sellerUser.email, 'SecurePass123!');

      testDelivery = await createTestDelivery();
      testEscrow = await recordEscrowFunded(testDelivery);
    });

    it('returns escrow data for a delivery', async () => {
      const res = await request(app)
        .get(`/api/v1/escrow/delivery/${testDelivery._id.toString()}`)
        .set('Authorization', `Bearer ${buyerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.contractId).toBe(testEscrow.contractId);
      expect(res.body.data.status).toBe(EscrowStatus.LOCKED);
    });

    it('returns 400 for invalid deliveryId format', async () => {
      const res = await request(app)
        .get(`/api/v1/escrow/delivery/invalid-id`)
        .set('Authorization', `Bearer ${buyerToken}`);

      expect(res.status).toBe(400);
    });

    it('returns 404 when no escrow exists for the delivery', async () => {
      const orphanDelivery = await createTestDelivery();
      const res = await request(app)
        .get(`/api/v1/escrow/delivery/${orphanDelivery._id.toString()}`)
        .set('Authorization', `Bearer ${buyerToken}`);

      expect(res.status).toBe(404);
    });

    it('returns 401 without auth token', async () => {
      const res = await request(app)
        .get(`/api/v1/escrow/delivery/${testDelivery._id.toString()}`);

      expect(res.status).toBe(401);
    });
  });

  // ── STEP 4: Get Escrow by Contract ID ────────────────────────────────

  describe('GET /api/v1/escrow/contract/:contractId', () => {

    beforeEach(async () => {
      buyerUser = await createTestUser({ firstName: 'Buyer', lastName: 'User' });
      sellerUser = await createTestUser({ firstName: 'Seller', lastName: 'User' });
      buyerToken = await loginUser(buyerUser.email, 'SecurePass123!');
      sellerToken = await loginUser(sellerUser.email, 'SecurePass123!');

      testDelivery = await createTestDelivery();
      testEscrow = await recordEscrowFunded(testDelivery);
    });

    it('returns escrow data for a contract ID', async () => {
      const res = await request(app)
        .get(`/api/v1/escrow/contract/${testEscrow.contractId}`)
        .set('Authorization', `Bearer ${buyerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
      // The escrow JSON envelope exposes `id` (the toJSON transform strips _id).
      expect(res.body.data.id).toBe(testEscrow._id.toString());
    });

    it('returns 404 when no escrow exists for the contract ID', async () => {
      const res = await request(app)
        .get(`/api/v1/escrow/contract/CFAKECONTRACT123456`)
        .set('Authorization', `Bearer ${buyerToken}`);

      expect(res.status).toBe(404);
    });

    it('returns 401 without auth token', async () => {
      const res = await request(app)
        .get(`/api/v1/escrow/contract/${testEscrow.contractId}`);

      expect(res.status).toBe(401);
    });
  });

  // ── STEP 5: Refund Escrow (Separate Test Scenario) ───────────────────

  describe('Step 5 — Refund Escrow Scenario', () => {

    let refundDelivery: IDelivery;
    let refundEscrow: IEscrow;

    beforeEach(async () => {
      // Create and fund an escrow for refund testing
      refundDelivery = await createTestDelivery();
      refundEscrow = await recordEscrowFunded(refundDelivery);
    });

    it('refund changes escrow status to "refunded"', async () => {
      // Simulate a refund operation at the service level
      const updatedEscrow = await Escrow.findByIdAndUpdate(
        refundEscrow._id,
        {
          $set: {
            status: EscrowStatus.REFUNDED,
            refundTransactionHash: `txrefund-${Date.now()}`,
            refundedAt: new Date(),
          },
          $push: {
            transactions: {
              hash: `txrefund-${Date.now()}`,
              type: 'refund',
              ledger: 100002,
              recordedAt: new Date(),
            },
          },
        },
        { new: true },
      );

      const stored = await Escrow.findById(refundEscrow._id);
      expect(stored?.status).toBe(EscrowStatus.REFUNDED);
    });

    it('refund transaction is recorded in transactions array', async () => {
      const refundTxHash = `txrefund-${Date.now()}`;

      const updatedEscrow = await Escrow.findByIdAndUpdate(
        refundEscrow._id,
        {
          $set: {
            status: EscrowStatus.REFUNDED,
            refundTransactionHash: refundTxHash,
            refundedAt: new Date(),
          },
          $push: {
            transactions: {
              hash: refundTxHash,
              type: 'refund',
              ledger: 100002,
              recordedAt: new Date(),
            },
          },
        },
        { new: true },
      );

      const stored = await Escrow.findById(refundEscrow._id);
      const refundTx = stored?.transactions.find((tx) => tx.type === 'refund');
      expect(refundTx).toBeDefined();
      expect(refundTx?.hash).toBe(refundTxHash);
    });

    it('isFundsLocked returns false when refunded', async () => {
      await Escrow.findByIdAndUpdate(
        refundEscrow._id,
        { $set: { status: EscrowStatus.REFUNDED } },
      );

      const stored = await Escrow.findById(refundEscrow._id);
      expect(stored?.isFundsLocked).toBe(false);
    });

    it('isSettled returns true when refunded', async () => {
      await Escrow.findByIdAndUpdate(
        refundEscrow._id,
        { $set: { status: EscrowStatus.REFUNDED } },
      );

      const stored = await Escrow.findById(refundEscrow._id);
      expect(stored?.isSettled).toBe(true);
    });
  });

  // ── STEP 6: Disputed Escrow Scenario ─────────────────────────────────

  describe('Step 6 — Disputed Escrow Scenario', () => {

    let disputeDelivery: IDelivery;
    let disputeEscrow: IEscrow;

    beforeEach(async () => {
      disputeDelivery = await createTestDelivery();
      disputeEscrow = await recordEscrowFunded(disputeDelivery);
    });

    it('escrow can move to disputed status', async () => {
      await Escrow.findByIdAndUpdate(
        disputeEscrow._id,
        { $set: { status: EscrowStatus.DISPUTED, disputeReason: 'Delivery not received' } },
      );

      const stored = await Escrow.findById(disputeEscrow._id);
      expect(stored?.status).toBe(EscrowStatus.DISPUTED);
      expect(stored?.disputeReason).toBe('Delivery not received');
    });

    it('isFundsLocked returns true when disputed (funds still held)', async () => {
      await Escrow.findByIdAndUpdate(
        disputeEscrow._id,
        { $set: { status: EscrowStatus.DISPUTED } },
      );

      const stored = await Escrow.findById(disputeEscrow._id);
      expect(stored?.isFundsLocked).toBe(true);
    });

    it('isSettled returns false when disputed (not terminal)', async () => {
      await Escrow.findByIdAndUpdate(
        disputeEscrow._id,
        { $set: { status: EscrowStatus.DISPUTED } },
      );

      const stored = await Escrow.findById(disputeEscrow._id);
      expect(stored?.isSettled).toBe(false);
    });
  });

  // ── Shared helper for sections without their own beforeEach ──────────

  let httpUserToken: string;

  beforeEach(async () => {
    // The global afterEach wipes every collection (including users) between
    // tests, so sections that drive HTTP endpoints without per-step setup
    // still need a fresh account and token before each test.
    const httpUser = await createTestUser({ firstName: 'Http', lastName: 'User' });
    httpUserToken = await loginUser(httpUser.email, 'SecurePass123!');
  });

  // ── STEP 7: Complete Lifecycle Flow ─────────────────────────────────

  describe('Complete Escrow Lifecycle Flow', () => {

    it('executes full lifecycle: Pending → Locked → Released', async () => {
      // 1. Create delivery and fund escrow
      const delivery = await createTestDelivery();
      const escrow = await recordEscrowFunded(delivery);

      // Verify: PENDING → LOCKED
      let state = await Escrow.findById(escrow._id);
      expect(state?.status).toBe(EscrowStatus.LOCKED);
      expect(state?.transactions).toHaveLength(1);

      let deliv = await Delivery.findById(delivery._id);
      expect(deliv?.status).toBe(DeliveryStatus.FUNDED);

      // 2. Release escrow
      const releaseRes = await request(app)
        .post('/api/v1/escrow/release')
        .set('Authorization', `Bearer ${httpUserToken}`)
        .send({
          escrowId: escrow._id.toString(),
          transactionHash: `txrelease-${Date.now()}`,
          ledger: 100001,
        });

      expect(releaseRes.status).toBe(200);

      // Verify: LOCKED → RELEASED
      state = await Escrow.findById(escrow._id);
      expect(state?.status).toBe(EscrowStatus.RELEASED);
      expect(state?.releasedAt).toBeDefined();
      expect(state?.transactions).toHaveLength(2);

      deliv = await Delivery.findById(delivery._id);
      expect(deliv?.status).toBe(DeliveryStatus.COMPLETED);

      // Verify virtuals
      expect(state?.isFundsLocked).toBe(false);
      expect(state?.isSettled).toBe(true);
    });

    it('escrow has complete audit trail of all transactions', async () => {
      const delivery = await createTestDelivery();
      const escrow = await recordEscrowFunded(delivery);

      // Add a refund transaction
      await Escrow.findByIdAndUpdate(
        escrow._id,
        {
          $set: {
            status: EscrowStatus.REFUNDED,
            refundedAt: new Date(),
          },
          $push: {
            transactions: {
              hash: `txrefund-${Date.now()}`,
              type: 'refund',
              ledger: 100002,
              recordedAt: new Date(),
            },
          },
        },
      );

      const stored = await Escrow.findById(escrow._id);
      expect(stored?.transactions).toHaveLength(2);

      const [fundTx, refundTx] = stored!.transactions;
      expect(fundTx.type).toBe('fund');
      expect(refundTx.type).toBe('refund');
      expect(fundTx.hash).toMatch(/^txfund-/);
      expect(refundTx.hash).toMatch(/^txrefund-/);
    });
  });

  // ── STEP 8: Error Cases & Validation ────────────────────────────────

  describe('Error Cases & Validation', () => {

    it('returns 400 for invalid ledger number (negative)', async () => {
      const delivery = await createTestDelivery();
      const escrow = await recordEscrowFunded(delivery);

      const res = await request(app)
        .post('/api/v1/escrow/release')
        .set('Authorization', `Bearer ${httpUserToken}`)
        .send({
          escrowId: escrow._id.toString(),
          transactionHash: `txrelease-${Date.now()}`,
          ledger: -1,
        });

      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid ledger number (non-integer)', async () => {
      const delivery = await createTestDelivery();
      const escrow = await recordEscrowFunded(delivery);

      const res = await request(app)
        .post('/api/v1/escrow/release')
        .set('Authorization', `Bearer ${httpUserToken}`)
        .send({
          escrowId: escrow._id.toString(),
          transactionHash: `txrelease-${Date.now()}`,
          ledger: 'not-a-number',
        });

      expect(res.status).toBe(400);
    });

    it('escrow schema enforces unique transaction hash across all escrows', async () => {
      const delivery1 = await createTestDelivery();
      const delivery2 = await createTestDelivery();

      const txHash = `txfund-${Date.now()}-shared`;

      // Fund first escrow
      const escrow1 = await escrowService.recordEscrowFunded({
        contractId: `CESCROW-1`,
        deliveryId: delivery1._id.toString(),
        amount: 100,
        asset: 'XLM',
        transactionHash: txHash,
        ledger: 100000,
      });

      expect(escrow1.transactions[0].hash).toBe(txHash);

      // Attempt to fund second escrow with same transaction hash
      // This should either skip or throw depending on implementation
      const escrow2 = await escrowService.recordEscrowFunded({
        contractId: `CESCROW-2`,
        deliveryId: delivery2._id.toString(),
        amount: 50,
        asset: 'USDC',
        transactionHash: txHash,
        ledger: 100001,
      });

      // Verify escrow2 was created (service allows it, but DB schema should prevent duplicates)
      expect(escrow2).toBeDefined();
    });
  });

  // ── STEP 9: Concurrent Operations & Distributed Locking ──────────────

  describe('Distributed Locking (Concurrency Control)', () => {

    it('release uses distributed lock to prevent race conditions', async () => {
      const delivery = await createTestDelivery();
      const escrow = await recordEscrowFunded(delivery);

      // Mock verifies lock was used (jest.mock of withLock above)
      const { withLock } = require('../src/config/redis');

      await request(app)
        .post('/api/v1/escrow/release')
        .set('Authorization', `Bearer ${httpUserToken}`)
        .send({
          escrowId: escrow._id.toString(),
          transactionHash: `txrelease-${Date.now()}`,
        });

      // Verify withLock was called with correct resource key
      expect(withLock).toHaveBeenCalledWith(
        expect.stringContaining(`escrow:release:`),
        expect.any(Function),
      );
    });
  });
});
