/**
 * Unit tests for the repository layer.
 *
 * Runs against a real in-process MongoDB (mongodb-memory-server) rather than
 * mocking Mongoose, so index constraints, validators and the conditional
 * update semantics the repositories rely on are genuinely exercised.
 */

import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import Delivery, { DeliveryStatus } from '../src/models/Delivery';
import User from '../src/models/User';
import Escrow, { EscrowStatus } from '../src/models/Escrow';
import { UserRole, UserStatus } from '../src/interfaces/IUser';
import { DeliveryRepository } from '../src/repositories/DeliveryRepository';
import { UserRepository } from '../src/repositories/UserRepository';
import { EscrowRepository } from '../src/repositories/EscrowRepository';

jest.mock('../src/config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

/** Build a valid delivery payload, overridable per test. */
const deliveryPayload = (overrides: Record<string, unknown> = {}) => ({
  trackingNumber: `TRK-${new Types.ObjectId().toHexString().slice(-8)}`,
  status: DeliveryStatus.PENDING,
  customer: { name: 'Ada Lovelace', phone: '+2348000000000' },
  pickup: { address: '1 Pickup Road' },
  dropoff: { address: '2 Dropoff Avenue' },
  package: { description: 'Documents', weight: 1.5 },
  deliveryFee: 1000,
  escrowAmount: 5000,
  ...overrides,
});

/** Build a valid user payload, overridable per test. */
const userPayload = (overrides: Record<string, unknown> = {}) => ({
  email: `user-${new Types.ObjectId().toHexString()}@example.com`,
  password: 'sup3rSecretPassword',
  firstName: 'Ada',
  lastName: 'Lovelace',
  role: UserRole.USER,
  ...overrides,
});

describe('Repository layer', () => {
  let mongod: MongoMemoryServer;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
  }, 60_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  }, 30_000);

  afterEach(async () => {
    await Promise.all([Delivery.deleteMany({}), User.deleteMany({}), Escrow.deleteMany({})]);
  });

  // ── BaseRepository behaviour, exercised through DeliveryRepository ─────────

  describe('BaseRepository', () => {
    const repository = new DeliveryRepository();

    it('creates and retrieves a document by id', async () => {
      const created = await repository.create(deliveryPayload());
      const found = await repository.findById(String(created._id));

      expect(found).not.toBeNull();
      expect(found?.trackingNumber).toBe(created.trackingNumber);
    });

    it('returns null for a malformed id instead of throwing a CastError', async () => {
      await expect(repository.findById('not-an-object-id')).resolves.toBeNull();
    });

    it('returns false when deleting a malformed id', async () => {
      await expect(repository.deleteById('not-an-object-id')).resolves.toBe(false);
    });

    it('returns null when updating a malformed id', async () => {
      await expect(
        repository.updateById('not-an-object-id', { $set: { deliveryFee: 1 } }),
      ).resolves.toBeNull();
    });

    it('creates many documents in one call', async () => {
      const created = await repository.createMany([
        deliveryPayload(),
        deliveryPayload(),
        deliveryPayload(),
      ]);

      expect(created).toHaveLength(3);
      await expect(repository.count({})).resolves.toBe(3);
    });

    it('returns an empty array when createMany is given no documents', async () => {
      await expect(repository.createMany([])).resolves.toEqual([]);
    });

    it('clamps pagination to sane bounds', async () => {
      await repository.createMany([deliveryPayload(), deliveryPayload()]);

      // Page 0 and a negative limit would otherwise produce a negative skip.
      const page = await repository.paginate({}, 0, -5);

      expect(page.page).toBe(1);
      expect(page.limit).toBeGreaterThan(0);
      expect(page.total).toBe(2);
    });

    it('caps the page size at 100 to prevent unbounded reads', async () => {
      const page = await repository.paginate({}, 1, 5000);
      expect(page.limit).toBe(100);
    });

    it('reports existence correctly', async () => {
      const created = await repository.create(deliveryPayload());

      await expect(repository.exists({ trackingNumber: created.trackingNumber })).resolves.toBe(
        true,
      );
      await expect(repository.exists({ trackingNumber: 'MISSING' })).resolves.toBe(false);
    });

    it('deletes a document by id', async () => {
      const created = await repository.create(deliveryPayload());

      await expect(repository.deleteById(String(created._id))).resolves.toBe(true);
      await expect(repository.findById(String(created._id))).resolves.toBeNull();
    });
  });

  // ── DeliveryRepository ────────────────────────────────────────────────────

  describe('DeliveryRepository', () => {
    const repository = new DeliveryRepository();

    it('finds a delivery by tracking number', async () => {
      const created = await repository.create(deliveryPayload({ trackingNumber: 'TRK-FIND' }));
      const found = await repository.findByTrackingNumber('TRK-FIND');

      expect(String(found?._id)).toBe(String(created._id));
    });

    it('resolves existing tracking numbers in a single query', async () => {
      await repository.create(deliveryPayload({ trackingNumber: 'TRK-A' }));
      await repository.create(deliveryPayload({ trackingNumber: 'TRK-B' }));

      const existing = await repository.findExistingTrackingNumbers([
        'TRK-A',
        'TRK-B',
        'TRK-MISSING',
      ]);

      expect(existing.has('TRK-A')).toBe(true);
      expect(existing.has('TRK-B')).toBe(true);
      expect(existing.has('TRK-MISSING')).toBe(false);
      expect(existing.size).toBe(2);
    });

    it('returns an empty set when asked about no tracking numbers', async () => {
      await expect(repository.findExistingTrackingNumbers([])).resolves.toEqual(new Set());
    });

    it('filters by status', async () => {
      await repository.create(deliveryPayload({ status: DeliveryStatus.PENDING }));
      await repository.create(deliveryPayload({ status: DeliveryStatus.COMPLETED }));

      const page = await repository.listPaginated({ status: DeliveryStatus.COMPLETED }, 1, 10);

      expect(page.total).toBe(1);
      expect(page.data[0].status).toBe(DeliveryStatus.COMPLETED);
    });

    it('treats regex metacharacters in search as literal text', async () => {
      await repository.create(deliveryPayload({ trackingNumber: 'TRK-A.B' }));
      await repository.create(deliveryPayload({ trackingNumber: 'TRK-AXB' }));

      // An unescaped '.' would match both; escaped, it matches only the literal.
      const page = await repository.listPaginated({ search: 'TRK-A.B' }, 1, 10);

      expect(page.total).toBe(1);
      expect(page.data[0].trackingNumber).toBe('TRK-A.B');
    });

    it('finds deliveries assigned to a driver', async () => {
      const driverId = new Types.ObjectId().toHexString();
      await repository.create(deliveryPayload({ driverId }));
      await repository.create(deliveryPayload());

      const found = await repository.findByDriver(driverId);

      expect(found).toHaveLength(1);
      expect(found[0].driverId).toBe(driverId);
    });

    describe('transitionStatus', () => {
      it('advances a delivery when it is in the expected state', async () => {
        const created = await repository.create(
          deliveryPayload({ status: DeliveryStatus.ASSIGNED }),
        );

        const updated = await repository.transitionStatus(
          String(created._id),
          DeliveryStatus.ASSIGNED,
          DeliveryStatus.IN_PROGRESS,
        );

        expect(updated?.status).toBe(DeliveryStatus.IN_PROGRESS);
      });

      it('refuses to advance from an unexpected state', async () => {
        const created = await repository.create(
          deliveryPayload({ status: DeliveryStatus.PENDING }),
        );

        const updated = await repository.transitionStatus(
          String(created._id),
          DeliveryStatus.IN_PROGRESS,
          DeliveryStatus.COMPLETED,
        );

        expect(updated).toBeNull();
        const unchanged = await repository.findById(String(created._id));
        expect(unchanged?.status).toBe(DeliveryStatus.PENDING);
      });

      it('lets only one of two concurrent transitions win', async () => {
        const created = await repository.create(
          deliveryPayload({ status: DeliveryStatus.ASSIGNED }),
        );

        const [first, second] = await Promise.all([
          repository.transitionStatus(
            String(created._id),
            DeliveryStatus.ASSIGNED,
            DeliveryStatus.IN_PROGRESS,
          ),
          repository.transitionStatus(
            String(created._id),
            DeliveryStatus.ASSIGNED,
            DeliveryStatus.IN_PROGRESS,
          ),
        ]);

        // Exactly one update matched the document; the other found nothing.
        expect([first, second].filter((result) => result !== null)).toHaveLength(1);
      });

      it('accepts a list of permitted source states', async () => {
        const created = await repository.create(deliveryPayload({ status: DeliveryStatus.FUNDED }));

        const updated = await repository.transitionStatus(
          String(created._id),
          [DeliveryStatus.PENDING, DeliveryStatus.FUNDED],
          DeliveryStatus.ASSIGNED,
        );

        expect(updated?.status).toBe(DeliveryStatus.ASSIGNED);
      });
    });
  });

  // ── UserRepository ────────────────────────────────────────────────────────

  describe('UserRepository', () => {
    const repository = new UserRepository();

    it('omits the password hash from ordinary reads', async () => {
      const created = await repository.create(userPayload({ email: 'ada@example.com' }));
      const found = await repository.findByEmail('ada@example.com');

      expect(String(found?._id)).toBe(String(created._id));
      expect(found?.password).toBeUndefined();
    });

    it('includes the password hash only when explicitly requested', async () => {
      await repository.create(userPayload({ email: 'grace@example.com' }));
      const found = await repository.findByEmailWithPassword('grace@example.com');

      expect(found?.password).toBeDefined();
      // Stored as a bcrypt hash, never as the plaintext.
      expect(found?.password).not.toBe('sup3rSecretPassword');
    });

    it('normalises email casing and whitespace on lookup', async () => {
      await repository.create(userPayload({ email: 'mixed@example.com' }));

      await expect(repository.findByEmail('  MIXED@example.com  ')).resolves.not.toBeNull();
      await expect(repository.emailExists('MiXeD@ExAmPlE.com')).resolves.toBe(true);
    });

    it('resolves several users by id, ignoring malformed ids', async () => {
      const first = await repository.create(userPayload());
      const second = await repository.create(userPayload());

      const found = await repository.findByIds([
        String(first._id),
        String(second._id),
        'not-an-object-id',
      ]);

      expect(found).toHaveLength(2);
    });

    it('returns an empty array when every id is malformed', async () => {
      await expect(repository.findByIds(['bad', 'worse'])).resolves.toEqual([]);
    });

    it('suspends and reactivates an account', async () => {
      const created = await repository.create(userPayload());

      const suspended = await repository.suspend(String(created._id), 'Policy violation');
      expect(suspended?.status).toBe(UserStatus.SUSPENDED);
      expect(suspended?.suspendedReason).toBe('Policy violation');
      expect(suspended?.isActive).toBe(false);

      const reactivated = await repository.reactivate(String(created._id));
      expect(reactivated?.status).toBe(UserStatus.ACTIVE);
      expect(reactivated?.isActive).toBe(true);
      expect(reactivated?.suspendedReason).toBeUndefined();
    });

    it('finds users by role', async () => {
      await repository.create(userPayload({ role: UserRole.DRIVER }));
      await repository.create(userPayload({ role: UserRole.USER }));

      const drivers = await repository.findByRole(UserRole.DRIVER);

      expect(drivers).toHaveLength(1);
      expect(drivers[0].role).toBe(UserRole.DRIVER);
    });
  });

  // ── EscrowRepository ──────────────────────────────────────────────────────

  describe('EscrowRepository', () => {
    const repository = new EscrowRepository();
    const deliveries = new DeliveryRepository();

    /** Create an escrow attached to a freshly created delivery. */
    const createEscrow = async (overrides: Record<string, unknown> = {}) => {
      const delivery = await deliveries.create(deliveryPayload());
      return repository.create({
        delivery: delivery._id as Types.ObjectId,
        contractId: `C${new Types.ObjectId().toHexString()}`,
        amount: 5000,
        assetCode: 'USDC',
        status: EscrowStatus.PENDING,
        transactions: [],
        ...overrides,
      });
    };

    it('finds an escrow by its delivery', async () => {
      const escrow = await createEscrow();
      const found = await repository.findByDeliveryId(String(escrow.delivery));

      expect(String(found?._id)).toBe(String(escrow._id));
    });

    it('returns null for a malformed delivery id', async () => {
      await expect(repository.findByDeliveryId('not-an-object-id')).resolves.toBeNull();
    });

    it('detects an already-recorded transaction hash', async () => {
      const escrow = await createEscrow();
      await repository.appendTransaction(String(escrow._id), {
        hash: 'hash-1',
        type: 'fund',
        recordedAt: new Date(),
      });

      await expect(repository.transactionHashExists('hash-1')).resolves.toBe(true);
      await expect(repository.transactionHashExists('hash-unknown')).resolves.toBe(false);
    });

    it('transitions status and stamps the lifecycle timestamp', async () => {
      const escrow = await createEscrow({ status: EscrowStatus.PENDING });

      const locked = await repository.transitionStatus(
        String(escrow._id),
        [EscrowStatus.PENDING],
        EscrowStatus.LOCKED,
        'lockedAt',
      );

      expect(locked?.status).toBe(EscrowStatus.LOCKED);
      expect(locked?.lockedAt).toBeInstanceOf(Date);
    });

    it('refuses a transition from an unexpected status', async () => {
      const escrow = await createEscrow({ status: EscrowStatus.RELEASED });

      const result = await repository.transitionStatus(
        String(escrow._id),
        [EscrowStatus.LOCKED],
        EscrowStatus.RELEASED,
        'releasedAt',
      );

      expect(result).toBeNull();
    });

    it('lets only one of two concurrent releases succeed', async () => {
      const escrow = await createEscrow({ status: EscrowStatus.LOCKED });

      const [first, second] = await Promise.all([
        repository.transitionStatus(
          String(escrow._id),
          [EscrowStatus.LOCKED],
          EscrowStatus.RELEASED,
          'releasedAt',
        ),
        repository.transitionStatus(
          String(escrow._id),
          [EscrowStatus.LOCKED],
          EscrowStatus.RELEASED,
          'releasedAt',
        ),
      ]);

      expect([first, second].filter((result) => result !== null)).toHaveLength(1);
    });

    it('finds escrows by status', async () => {
      await createEscrow({ status: EscrowStatus.LOCKED });
      await createEscrow({ status: EscrowStatus.PENDING });

      const locked = await repository.findByStatus(EscrowStatus.LOCKED);

      expect(locked).toHaveLength(1);
      expect(locked[0].status).toBe(EscrowStatus.LOCKED);
    });
  });
});
