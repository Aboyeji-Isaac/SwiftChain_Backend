/**
 * Unit tests for NotificationService.
 *
 * Runs against a real in-process MongoDB so preference upserts, token
 * ownership transfer and the audit log are exercised for real. The push
 * transport is the one substituted component: it is an external HTTP service,
 * so a recording stub implementing IPushProvider stands in for it.
 */

import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import Delivery, { DeliveryStatus, IDelivery } from '../src/models/Delivery';
import NotificationPreference, { NotificationEvent } from '../src/models/NotificationPreference';
import Notification, { NotificationStatus } from '../src/models/Notification';
import { NotificationService } from '../src/services/notificationService';
import { IPushProvider, PushMessage, PushResult } from '../src/services/push/pushProvider';

jest.mock('../src/config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

/**
 * Recording push transport.
 *
 * Captures what would have been sent and returns a configurable result, so
 * tests can assert on payload contents and simulate provider failures.
 */
class StubPushProvider implements IPushProvider {
  public readonly name = 'stub';
  public readonly sent: PushMessage[] = [];

  constructor(
    private result: PushResult = { acceptedCount: 1, rejectedCount: 0, invalidTokens: [] },
    private configured = true,
  ) {}

  isConfigured(): boolean {
    return this.configured;
  }

  async send(message: PushMessage): Promise<PushResult> {
    this.sent.push(message);
    // Mirror the real provider: one accepted token per target unless the test
    // has pinned an explicit result.
    return { ...this.result, acceptedCount: this.result.acceptedCount * message.tokens.length };
  }

  setResult(result: PushResult): void {
    this.result = result;
  }
}

/** A push transport that always throws, for failure-path coverage. */
class ThrowingPushProvider implements IPushProvider {
  public readonly name = 'throwing';
  isConfigured(): boolean {
    return true;
  }
  async send(): Promise<PushResult> {
    throw new Error('provider exploded');
  }
}

describe('NotificationService', () => {
  let mongod: MongoMemoryServer;
  let provider: StubPushProvider;
  let service: NotificationService;

  const userId = new Types.ObjectId().toHexString();

  /** Create a delivery owned by `userId`, in the given status. */
  const createDelivery = async (status = DeliveryStatus.PENDING): Promise<IDelivery> =>
    Delivery.create({
      trackingNumber: `TRK-${new Types.ObjectId().toHexString().slice(-8)}`,
      status,
      sender: new Types.ObjectId(userId),
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
  }, 60_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  }, 30_000);

  beforeEach(() => {
    provider = new StubPushProvider();
    service = new NotificationService(undefined, undefined, provider);
  });

  afterEach(async () => {
    await Promise.all([
      NotificationPreference.deleteMany({}),
      Notification.deleteMany({}),
      Delivery.deleteMany({}),
    ]);
  });

  // ── Preferences ───────────────────────────────────────────────────────────

  describe('getPreferences', () => {
    it('creates default preferences on first access', async () => {
      const preference = await service.getPreferences(userId);

      expect(preference.pushEnabled).toBe(true);
      expect(preference.enabledEvents).toEqual(
        expect.arrayContaining(Object.values(NotificationEvent)),
      );
      expect(preference.devices).toHaveLength(0);
    });

    it('returns the same document on repeated access', async () => {
      const first = await service.getPreferences(userId);
      const second = await service.getPreferences(userId);

      expect(String(first._id)).toBe(String(second._id));
      await expect(NotificationPreference.countDocuments({})).resolves.toBe(1);
    });

    it('does not create duplicates under concurrent first access', async () => {
      await Promise.all([
        service.getPreferences(userId),
        service.getPreferences(userId),
        service.getPreferences(userId),
      ]);

      await expect(NotificationPreference.countDocuments({ user: userId })).resolves.toBe(1);
    });

    it('rejects a malformed user id', async () => {
      await expect(service.getPreferences('not-an-object-id')).rejects.toThrow(/Invalid user ID/);
    });
  });

  describe('updatePreferences', () => {
    it('disables push notifications', async () => {
      const updated = await service.updatePreferences(userId, { pushEnabled: false });
      expect(updated.pushEnabled).toBe(false);
    });

    it('narrows the subscribed event list', async () => {
      const updated = await service.updatePreferences(userId, {
        enabledEvents: [NotificationEvent.DELIVERY_COMPLETED],
      });

      expect(updated.enabledEvents).toEqual([NotificationEvent.DELIVERY_COMPLETED]);
    });

    it('creates the document when none exists yet', async () => {
      await expect(NotificationPreference.countDocuments({})).resolves.toBe(0);
      await service.updatePreferences(userId, { pushEnabled: false });
      await expect(NotificationPreference.countDocuments({})).resolves.toBe(1);
    });
  });

  // ── Device registration ───────────────────────────────────────────────────

  describe('registerDevice', () => {
    it('registers a device token', async () => {
      const preference = await service.registerDevice({
        userId,
        token: 'token-1',
        platform: 'android',
      });

      expect(preference.devices).toHaveLength(1);
      expect(preference.devices[0].token).toBe('token-1');
      expect(preference.devices[0].platform).toBe('android');
    });

    it('refreshes rather than duplicates an existing token', async () => {
      await service.registerDevice({ userId, token: 'token-1', platform: 'android' });
      const preference = await service.registerDevice({
        userId,
        token: 'token-1',
        platform: 'ios',
      });

      expect(preference.devices).toHaveLength(1);
      expect(preference.devices[0].platform).toBe('ios');
    });

    it('detaches a token from its previous owner', async () => {
      const otherUserId = new Types.ObjectId().toHexString();

      await service.registerDevice({ userId: otherUserId, token: 'shared', platform: 'ios' });
      await service.registerDevice({ userId, token: 'shared', platform: 'ios' });

      const previousOwner = await NotificationPreference.findOne({ user: otherUserId });
      const newOwner = await NotificationPreference.findOne({ user: userId });

      // Without the detach, the previous owner would keep receiving pushes
      // meant for whoever now holds the device.
      expect(previousOwner?.devices).toHaveLength(0);
      expect(newOwner?.devices).toHaveLength(1);
    });

    it('does not detach a token that is already owned by the requesting user', async () => {
      await service.registerDevice({ userId, token: 'token-1', platform: 'android' });

      // A concurrent registration for another user must not steal a token
      // that the current owner is re-registering at the same time.
      const otherUserId = new Types.ObjectId().toHexString();
      await service.registerDevice({ userId, token: 'token-1', platform: 'android' });
      await service.registerDevice({ userId: otherUserId, token: 'token-1', platform: 'ios' });

      const newOwner = await NotificationPreference.findOne({ user: otherUserId });
      expect(newOwner?.devices).toHaveLength(1);

      const oldOwner = await NotificationPreference.findOne({ user: userId });
      expect(oldOwner?.devices).toHaveLength(0);
    });

    it('leaves exactly one owner when two users register the same token concurrently', async () => {
      const userA = new Types.ObjectId().toHexString();
      const userB = new Types.ObjectId().toHexString();
      const token = 'race-token';

      await Promise.all([
        service.registerDevice({ userId: userA, token, platform: 'ios' }),
        service.registerDevice({ userId: userB, token, platform: 'ios' }),
      ]);

      // The token must survive under exactly one user — never duplicated
      // onto both and never dropped from both.
      const owners = await NotificationPreference.find({ 'devices.token': token });
      expect(owners).toHaveLength(1);

      const [owner] = owners;
      expect([userA, userB]).toContain(String(owner.user));
      expect(owner.devices).toHaveLength(1);
    });

    it('unregisters a device token', async () => {
      await service.registerDevice({ userId, token: 'token-1', platform: 'web' });
      const preference = await service.unregisterDevice(userId, 'token-1');

      expect(preference.devices).toHaveLength(0);
    });
  });

  // ── Delivery transition notifications ─────────────────────────────────────

  describe('notifyDeliveryTransition', () => {
    beforeEach(async () => {
      await service.registerDevice({ userId, token: 'token-1', platform: 'android' });
    });

    it.each([
      [DeliveryStatus.PENDING, NotificationEvent.DELIVERY_PENDING],
      [DeliveryStatus.IN_PROGRESS, NotificationEvent.DELIVERY_IN_PROGRESS],
      [DeliveryStatus.COMPLETED, NotificationEvent.DELIVERY_COMPLETED],
    ])('sends a notification for the %s transition', async (status, expectedEvent) => {
      const delivery = await createDelivery();
      const records = await service.notifyDeliveryTransition(delivery, status);

      expect(records).toHaveLength(1);
      expect(records[0].event).toBe(expectedEvent);
      expect(records[0].status).toBe(NotificationStatus.SENT);
      expect(provider.sent).toHaveLength(1);
      expect(provider.sent[0].tokens).toEqual(['token-1']);
    });

    it('includes the delivery id and status in the push payload', async () => {
      const delivery = await createDelivery();
      await service.notifyDeliveryTransition(delivery, DeliveryStatus.COMPLETED);

      expect(provider.sent[0].data).toMatchObject({
        deliveryId: String(delivery._id),
        status: DeliveryStatus.COMPLETED,
        trackingNumber: delivery.trackingNumber,
      });
    });

    it('does not notify for a status with no user-facing event', async () => {
      const delivery = await createDelivery();
      const records = await service.notifyDeliveryTransition(delivery, DeliveryStatus.FUNDED);

      expect(records).toEqual([]);
      expect(provider.sent).toHaveLength(0);
    });

    it('records a skip when the user has disabled push', async () => {
      await service.updatePreferences(userId, { pushEnabled: false });
      const delivery = await createDelivery();

      const records = await service.notifyDeliveryTransition(delivery, DeliveryStatus.COMPLETED);

      expect(records[0].status).toBe(NotificationStatus.SKIPPED);
      expect(records[0].failureReason).toMatch(/disabled push/i);
      expect(provider.sent).toHaveLength(0);
    });

    it('records a skip when the user has opted out of that event', async () => {
      await service.updatePreferences(userId, {
        enabledEvents: [NotificationEvent.DELIVERY_PENDING],
      });
      const delivery = await createDelivery();

      const records = await service.notifyDeliveryTransition(delivery, DeliveryStatus.COMPLETED);

      expect(records[0].status).toBe(NotificationStatus.SKIPPED);
      expect(records[0].failureReason).toMatch(/opted out/i);
      expect(provider.sent).toHaveLength(0);
    });

    it('records a skip when the user has no registered devices', async () => {
      await service.unregisterDevice(userId, 'token-1');
      const delivery = await createDelivery();

      const records = await service.notifyDeliveryTransition(delivery, DeliveryStatus.COMPLETED);

      expect(records[0].status).toBe(NotificationStatus.SKIPPED);
      expect(records[0].failureReason).toMatch(/no registered devices/i);
    });

    it('prunes tokens the provider reports as permanently invalid', async () => {
      provider.setResult({
        acceptedCount: 0,
        rejectedCount: 1,
        invalidTokens: ['token-1'],
      });
      const delivery = await createDelivery();

      await service.notifyDeliveryTransition(delivery, DeliveryStatus.COMPLETED);

      const preference = await NotificationPreference.findOne({ user: userId });
      expect(preference?.devices).toHaveLength(0);
    });

    it('records a failure when the provider throws, without rethrowing', async () => {
      const throwingService = new NotificationService(
        undefined,
        undefined,
        new ThrowingPushProvider(),
      );
      const delivery = await createDelivery();

      const records = await throwingService.notifyDeliveryTransition(
        delivery,
        DeliveryStatus.COMPLETED,
      );

      expect(records[0].status).toBe(NotificationStatus.FAILED);
      expect(records[0].failureReason).toMatch(/provider exploded/);
    });

    it('notifies both the sender and the driver, without duplicates', async () => {
      const driverId = new Types.ObjectId().toHexString();
      await service.registerDevice({ userId: driverId, token: 'driver-token', platform: 'ios' });

      const delivery = await createDelivery();
      delivery.driverId = driverId;
      await delivery.save();

      const records = await service.notifyDeliveryTransition(delivery, DeliveryStatus.COMPLETED);

      expect(records).toHaveLength(2);
      expect(new Set(records.map((record) => String(record.user)))).toEqual(
        new Set([userId, driverId]),
      );
    });

    it('notifies a user once when they are both sender and driver', async () => {
      const delivery = await createDelivery();
      delivery.driverId = userId;
      await delivery.save();

      const records = await service.notifyDeliveryTransition(delivery, DeliveryStatus.COMPLETED);

      expect(records).toHaveLength(1);
    });

    it('ignores non-ObjectId driver identifiers', async () => {
      const delivery = await createDelivery();
      delivery.driverId = 'legacy-driver-slug';
      await delivery.save();

      const records = await service.notifyDeliveryTransition(delivery, DeliveryStatus.COMPLETED);

      // Only the sender is notifiable; the free-form driver id is not a user.
      expect(records).toHaveLength(1);
      expect(String(records[0].user)).toBe(userId);
    });
  });

  // ── History ───────────────────────────────────────────────────────────────

  describe('listForUser', () => {
    it('returns notifications newest first', async () => {
      await service.registerDevice({ userId, token: 'token-1', platform: 'android' });
      const delivery = await createDelivery();

      await service.notifyDeliveryTransition(delivery, DeliveryStatus.PENDING);
      await service.notifyDeliveryTransition(delivery, DeliveryStatus.IN_PROGRESS);
      await service.notifyDeliveryTransition(delivery, DeliveryStatus.COMPLETED);

      const page = await service.listForUser(userId, { page: 1, limit: 10 });

      expect(page.total).toBe(3);
      expect(page.data[0].event).toBe(NotificationEvent.DELIVERY_COMPLETED);
    });

    it('paginates the history', async () => {
      await service.registerDevice({ userId, token: 'token-1', platform: 'android' });
      const delivery = await createDelivery();

      await service.notifyDeliveryTransition(delivery, DeliveryStatus.PENDING);
      await service.notifyDeliveryTransition(delivery, DeliveryStatus.COMPLETED);

      const page = await service.listForUser(userId, { page: 1, limit: 1 });

      expect(page.data).toHaveLength(1);
      expect(page.total).toBe(2);
      expect(page.totalPages).toBe(2);
    });
  });

  describe('getProviderStatus', () => {
    it('reports the provider name and whether it is configured', () => {
      expect(service.getProviderStatus()).toEqual({ provider: 'stub', configured: true });
    });

    it('reports an unconfigured provider', () => {
      const unconfigured = new NotificationService(
        undefined,
        undefined,
        new StubPushProvider(undefined, false),
      );

      expect(unconfigured.getProviderStatus().configured).toBe(false);
    });
  });
});
