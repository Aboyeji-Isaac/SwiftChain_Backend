/**
 * Unit tests for DeliveryService.updateStatus — the delivery state machine
 * and the notification trigger it fires.
 *
 * Runs against a real in-process MongoDB. The push transport is stubbed at the
 * notification-service boundary because it is an external HTTP dependency;
 * everything below it (preferences, the audit log, the conditional update) is
 * exercised for real.
 */

import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import Delivery, { DeliveryStatus, IDelivery } from '../src/models/Delivery';
import Notification, { NotificationStatus } from '../src/models/Notification';
import NotificationPreference, { NotificationEvent } from '../src/models/NotificationPreference';
import { DeliveryService } from '../src/services/delivery.service';
import { notificationService } from '../src/services/notificationService';

jest.mock('../src/config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

describe('DeliveryService.updateStatus', () => {
  let mongod: MongoMemoryServer;
  let service: DeliveryService;
  let notifySpy: jest.SpyInstance;

  const senderId = new Types.ObjectId();

  /** Create a delivery in the given status, owned by `senderId`. */
  const createDelivery = async (status: DeliveryStatus): Promise<IDelivery> =>
    Delivery.create({
      trackingNumber: `TRK-${new Types.ObjectId().toHexString().slice(-8)}`,
      status,
      sender: senderId,
      customer: { name: 'Ada', phone: '+2348000000000' },
      pickup: { address: 'A' },
      dropoff: { address: 'B' },
      package: { description: 'Docs', weight: 1 },
      deliveryFee: 100,
      escrowAmount: 500,
    });

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    service = new DeliveryService();
  }, 60_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  }, 30_000);

  beforeEach(() => {
    // The transport itself is covered in notificationService.test.ts; here we
    // only care that the transition fires it with the right arguments.
    notifySpy = jest.spyOn(notificationService, 'notifyDeliveryTransition').mockResolvedValue([]);
  });

  afterEach(async () => {
    notifySpy.mockRestore();
    await Promise.all([
      Delivery.deleteMany({}),
      Notification.deleteMany({}),
      NotificationPreference.deleteMany({}),
    ]);
  });

  // ── Permitted transitions ─────────────────────────────────────────────────

  describe('permitted transitions', () => {
    it.each([
      [DeliveryStatus.PENDING, DeliveryStatus.FUNDED],
      [DeliveryStatus.PENDING, DeliveryStatus.ASSIGNED],
      [DeliveryStatus.PENDING, DeliveryStatus.CANCELLED],
      [DeliveryStatus.FUNDED, DeliveryStatus.ASSIGNED],
      [DeliveryStatus.ASSIGNED, DeliveryStatus.IN_PROGRESS],
      [DeliveryStatus.IN_PROGRESS, DeliveryStatus.COMPLETED],
      [DeliveryStatus.IN_PROGRESS, DeliveryStatus.CANCELLED],
    ])('allows %s -> %s', async (from, to) => {
      const delivery = await createDelivery(from);
      const updated = await service.updateStatus(String(delivery._id), to);

      expect(updated.status).toBe(to);
    });

    it('walks the full pending -> in progress -> completed path', async () => {
      const delivery = await createDelivery(DeliveryStatus.PENDING);
      const id = String(delivery._id);

      await service.updateStatus(id, DeliveryStatus.ASSIGNED);
      await service.updateStatus(id, DeliveryStatus.IN_PROGRESS);
      const completed = await service.updateStatus(id, DeliveryStatus.COMPLETED);

      expect(completed.status).toBe(DeliveryStatus.COMPLETED);
      expect(notifySpy).toHaveBeenCalledTimes(3);
    });
  });

  // ── Rejected transitions ──────────────────────────────────────────────────

  describe('rejected transitions', () => {
    it('rejects skipping a state', async () => {
      const delivery = await createDelivery(DeliveryStatus.PENDING);

      await expect(
        service.updateStatus(String(delivery._id), DeliveryStatus.COMPLETED),
      ).rejects.toThrow(/Cannot transition a delivery from 'pending' to 'completed'/);
    });

    it('rejects moving out of a terminal state', async () => {
      const delivery = await createDelivery(DeliveryStatus.COMPLETED);

      await expect(
        service.updateStatus(String(delivery._id), DeliveryStatus.IN_PROGRESS),
      ).rejects.toThrow(/terminal state/);
    });

    it('rejects a no-op transition to the current status', async () => {
      const delivery = await createDelivery(DeliveryStatus.PENDING);

      await expect(
        service.updateStatus(String(delivery._id), DeliveryStatus.PENDING),
      ).rejects.toThrow(/already in status/);
    });

    it('rejects a malformed delivery id', async () => {
      await expect(
        service.updateStatus('not-an-object-id', DeliveryStatus.COMPLETED),
      ).rejects.toThrow(/Invalid delivery ID/);
    });

    it('rejects an unknown delivery', async () => {
      await expect(
        service.updateStatus(new Types.ObjectId().toHexString(), DeliveryStatus.COMPLETED),
      ).rejects.toThrow(/not found/);
    });

    it('does not notify when the transition is rejected', async () => {
      const delivery = await createDelivery(DeliveryStatus.PENDING);

      await expect(
        service.updateStatus(String(delivery._id), DeliveryStatus.COMPLETED),
      ).rejects.toThrow();

      expect(notifySpy).not.toHaveBeenCalled();
    });

    it('leaves the stored status unchanged when rejected', async () => {
      const delivery = await createDelivery(DeliveryStatus.PENDING);

      await expect(
        service.updateStatus(String(delivery._id), DeliveryStatus.COMPLETED),
      ).rejects.toThrow();

      const unchanged = await Delivery.findById(delivery._id);
      expect(unchanged?.status).toBe(DeliveryStatus.PENDING);
    });
  });

  // ── Concurrency ───────────────────────────────────────────────────────────

  describe('concurrent transitions', () => {
    it('lets only one of two identical transitions succeed', async () => {
      const delivery = await createDelivery(DeliveryStatus.ASSIGNED);
      const id = String(delivery._id);

      const results = await Promise.allSettled([
        service.updateStatus(id, DeliveryStatus.IN_PROGRESS),
        service.updateStatus(id, DeliveryStatus.IN_PROGRESS),
      ]);

      const fulfilled = results.filter((result) => result.status === 'fulfilled');
      expect(fulfilled).toHaveLength(1);
      // The loser is rejected rather than silently overwriting the winner.
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    });

    it('notifies once per successful transition, not per attempt', async () => {
      const delivery = await createDelivery(DeliveryStatus.ASSIGNED);
      const id = String(delivery._id);

      await Promise.allSettled([
        service.updateStatus(id, DeliveryStatus.IN_PROGRESS),
        service.updateStatus(id, DeliveryStatus.IN_PROGRESS),
      ]);

      expect(notifySpy).toHaveBeenCalledTimes(1);
    });
  });

  // ── Notification integration ──────────────────────────────────────────────

  describe('notification trigger', () => {
    it('notifies with the delivery and its new status', async () => {
      const delivery = await createDelivery(DeliveryStatus.ASSIGNED);
      await service.updateStatus(String(delivery._id), DeliveryStatus.IN_PROGRESS);

      expect(notifySpy).toHaveBeenCalledWith(
        expect.objectContaining({ status: DeliveryStatus.IN_PROGRESS }),
        DeliveryStatus.IN_PROGRESS,
      );
    });

    it('commits the transition even when notification dispatch fails', async () => {
      notifySpy.mockRejectedValueOnce(new Error('push provider unreachable'));
      const delivery = await createDelivery(DeliveryStatus.ASSIGNED);

      // The rejection propagates, but the status write has already committed:
      // a delivery must never revert because a push failed.
      await expect(
        service.updateStatus(String(delivery._id), DeliveryStatus.IN_PROGRESS),
      ).rejects.toThrow(/push provider unreachable/);

      const stored = await Delivery.findById(delivery._id);
      expect(stored?.status).toBe(DeliveryStatus.IN_PROGRESS);
    });

    it('writes an audit record end to end through the real service', async () => {
      notifySpy.mockRestore();

      await NotificationPreference.create({
        user: senderId,
        pushEnabled: true,
        enabledEvents: Object.values(NotificationEvent),
        devices: [],
      });

      const delivery = await createDelivery(DeliveryStatus.ASSIGNED);
      await service.updateStatus(String(delivery._id), DeliveryStatus.IN_PROGRESS);

      const records = await Notification.find({ user: senderId });

      expect(records).toHaveLength(1);
      expect(records[0].event).toBe(NotificationEvent.DELIVERY_IN_PROGRESS);
      // No devices registered, so the send is suppressed rather than attempted.
      expect(records[0].status).toBe(NotificationStatus.SKIPPED);
    });
  });
});
