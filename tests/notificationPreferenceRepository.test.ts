/**
 * Repository tests for NotificationPreferenceRepository.
 *
 * Runs against a real in-process MongoDB (mongodb-memory-server) so the
 * unique `devices.token` index and the atomic update semantics used for
 * device attach/detach are exercised for real, not mocked.
 */

import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import NotificationPreference, { NotificationEvent } from '../src/models/NotificationPreference';
import { NotificationPreferenceRepository } from '../src/repositories/NotificationPreferenceRepository';

jest.mock('../src/config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: MongoMemoryServer;
let repository: NotificationPreferenceRepository;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  // Build indexes up front so the unique `devices.token` constraint is in place.
  await NotificationPreference.init();
  repository = new NotificationPreferenceRepository();
}, 120_000);

afterEach(async () => {
  await NotificationPreference.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

const newUserId = (): Types.ObjectId => new Types.ObjectId();

describe('NotificationPreferenceRepository', () => {
  describe('findOrCreateByUserId', () => {
    it('creates default preferences on first call', async () => {
      const userId = newUserId();

      const preference = await repository.findOrCreateByUserId(userId);

      expect(preference.user.toString()).toBe(userId.toString());
      expect(preference.pushEnabled).toBe(true);
      expect(preference.enabledEvents).toEqual(Object.values(NotificationEvent));
      expect(preference.devices).toEqual([]);
    });

    it('returns the existing document instead of creating a duplicate', async () => {
      const userId = newUserId();

      const first = await repository.findOrCreateByUserId(userId);
      const second = await repository.findOrCreateByUserId(userId);

      expect(second.id).toBe(first.id);
      expect(await NotificationPreference.countDocuments({ user: userId })).toBe(1);
    });
  });

  describe('registerDevice', () => {
    it('attaches a token to the user', async () => {
      const userId = newUserId();

      const updated = await repository.registerDevice(userId, {
        token: 'token-a',
        platform: 'android',
      });

      expect(updated.devices).toHaveLength(1);
      expect(updated.devices[0].token).toBe('token-a');
      expect(updated.devices[0].platform).toBe('android');
      expect(updated.devices[0].lastSeenAt).toBeInstanceOf(Date);
    });

    it('detaches the token from the previous owner when it is handed to another user', async () => {
      const previousOwner = newUserId();
      const newOwner = newUserId();

      await repository.registerDevice(previousOwner, { token: 'shared-token', platform: 'ios' });
      await repository.registerDevice(newOwner, { token: 'shared-token', platform: 'ios' });

      const previous = await NotificationPreference.findOne({ user: previousOwner }).lean();
      const current = await NotificationPreference.findOne({ user: newOwner }).lean();

      expect(previous?.devices).toEqual([]);
      expect(current?.devices.map((d) => d.token)).toEqual(['shared-token']);
      expect(await NotificationPreference.countDocuments({ 'devices.token': 'shared-token' })).toBe(
        1,
      );
    });

    it('is idempotent when the same user re-registers an owned token', async () => {
      const userId = newUserId();

      await repository.registerDevice(userId, { token: 'token-a', platform: 'android' });
      const refreshed = await repository.registerDevice(userId, {
        token: 'token-a',
        platform: 'web',
      });

      expect(refreshed.devices).toHaveLength(1);
      expect(refreshed.devices[0].token).toBe('token-a');
      expect(refreshed.devices[0].platform).toBe('web');
    });

    it('keeps other tokens belonging to the same user when re-registering one of them', async () => {
      const userId = newUserId();

      await repository.registerDevice(userId, { token: 'token-a', platform: 'android' });
      await repository.registerDevice(userId, { token: 'token-b', platform: 'ios' });
      const refreshed = await repository.registerDevice(userId, {
        token: 'token-a',
        platform: 'android',
      });

      expect(refreshed.devices.map((d) => d.token).sort()).toEqual(['token-a', 'token-b']);
    });
  });

  describe('removeDevice', () => {
    it('removes only the specified token', async () => {
      const userId = newUserId();
      await repository.registerDevice(userId, { token: 'token-a', platform: 'android' });
      await repository.registerDevice(userId, { token: 'token-b', platform: 'ios' });

      const updated = await repository.removeDevice(userId, 'token-a');

      expect(updated?.devices.map((d) => d.token)).toEqual(['token-b']);
    });

    it('returns null when the user has no preference document', async () => {
      const result = await repository.removeDevice(newUserId(), 'missing-token');

      expect(result).toBeNull();
    });
  });

  describe('pruneTokens', () => {
    it('removes the listed tokens across users and reports the modified count', async () => {
      const userA = newUserId();
      const userB = newUserId();
      await repository.registerDevice(userA, { token: 'stale-1', platform: 'android' });
      await repository.registerDevice(userA, { token: 'keep-me', platform: 'ios' });
      await repository.registerDevice(userB, { token: 'stale-2', platform: 'web' });

      const modified = await repository.pruneTokens(['stale-1', 'stale-2']);

      expect(modified).toBe(2);
      const a = await NotificationPreference.findOne({ user: userA }).lean();
      const b = await NotificationPreference.findOne({ user: userB }).lean();
      expect(a?.devices.map((d) => d.token)).toEqual(['keep-me']);
      expect(b?.devices).toEqual([]);
    });

    it('returns 0 without touching the database when given no tokens', async () => {
      const userId = newUserId();
      await repository.registerDevice(userId, { token: 'token-a', platform: 'android' });

      const modified = await repository.pruneTokens([]);

      expect(modified).toBe(0);
      const preference = await NotificationPreference.findOne({ user: userId }).lean();
      expect(preference?.devices.map((d) => d.token)).toEqual(['token-a']);
    });

    it('returns 0 when none of the listed tokens are registered', async () => {
      const userId = newUserId();
      await repository.registerDevice(userId, { token: 'token-a', platform: 'android' });

      expect(await repository.pruneTokens(['unknown-token'])).toBe(0);
    });
  });
});
