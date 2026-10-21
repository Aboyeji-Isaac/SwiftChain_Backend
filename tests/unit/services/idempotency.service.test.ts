/**
 * Unit tests for IdempotencyService.
 *
 * The idempotency store protects escrow funding from duplicate charges, so
 * these tests exercise every branch of the Redis-primary / Mongo-fallback
 * design:
 *
 *  - `markProcessing` NX semantics (first writer wins, others get 409).
 *  - `markCompleted` / `markFailed` persistence and response replay.
 *  - Mongo fallback when Redis is absent or unreachable.
 *  - TTL / expiry behaviour in both stores.
 *
 * MongoDB is a real in-process instance (mongodb-memory-server) so every
 * assertion about persisted state is read back from the database. Redis is
 * replaced by `InMemoryRedis`, a typed double that implements the NX / EX /
 * SETEX / TTL semantics the service relies on and can simulate an outage.
 */

import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import httpStatus from 'http-status-codes';
import { v4 as uuidv4 } from 'uuid';

import { InMemoryRedis } from '../helpers/InMemoryRedis';

/**
 * Holder read lazily by the mocked `config/redis` module. Tests swap the
 * client (or set it to `null`) to choose between the Redis and Mongo paths.
 */
const mockRedisHolder: { client: InMemoryRedis | null } = { client: null };

jest.mock('../../../src/config/redis', () => ({
  __esModule: true,
  get redisClient(): InMemoryRedis | null {
    return mockRedisHolder.client;
  },
}));

// Imports below resolve the mocked redis module above.
import { IdempotencyService, IdempotencyPayload } from '../../../src/services/idempotency.service';
import IdempotencyRecord from '../../../src/models/IdempotencyRecord';
import env from '../../../src/config/env';
import logger from '../../../src/config/logger';
import { AppError } from '../../../src/utils/AppError';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TTL_SECONDS = env.IDEMPOTENCY_TTL_SECONDS;
const TTL_MS = TTL_SECONDS * 1000;

/** Unique key per test so no state can leak between cases. */
const newKey = (): string => uuidv4();

/** Endpoint discriminator in the same shape the middleware builds. */
const ESCROW_FUND_ENDPOINT = 'POST:/api/v1/escrow/fund';
const DELIVERY_CREATE_ENDPOINT = 'POST:/api/v1/deliveries';

const redisKeyFor = (key: string, endpoint: string): string => `idempotency:${endpoint}:${key}`;

/** Builds a realistic escrow-funding success body for a given key. */
const fundedBody = (key: string): Record<string, unknown> => ({
  success: true,
  data: {
    escrowId: new mongoose.Types.ObjectId().toHexString(),
    idempotencyKey: key,
    status: 'FUNDED',
    amount: '125.5000000',
    assetCode: 'USDC',
  },
});

/** Builds an error body as produced by the global error handler. */
const failureBody = (message: string): Record<string, unknown> => ({
  success: false,
  error: { message, statusCode: httpStatus.BAD_GATEWAY },
});

/** Emulates the MongoDB TTL monitor, which purges documents whose `expiresAt` passed. */
const runMongoTtlMonitor = async (): Promise<void> => {
  await IdempotencyRecord.deleteMany({ expiresAt: { $lte: new Date(Date.now()) } });
};

/** Asserts a promise rejects with a 409 AppError. */
const expectConflict = async (promise: Promise<unknown>): Promise<void> => {
  await expect(promise).rejects.toBeInstanceOf(AppError);
  await promise.catch((err: AppError) => {
    expect(err.statusCode).toBe(httpStatus.CONFLICT);
    expect(err.message).toMatch(/already being processed/i);
  });
};

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('IdempotencyService', () => {
  let mongod: MongoMemoryServer;
  let redis: InMemoryRedis;
  let service: IdempotencyService;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    // Ensure the unique (key, endpoint) and TTL indexes exist before asserting on them.
    await IdempotencyRecord.init();
  }, 120_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  }, 30_000);

  beforeEach(() => {
    redis = new InMemoryRedis(() => Date.now());
    mockRedisHolder.client = redis;
    service = new IdempotencyService();
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => logger);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await redis.flushall();
    await IdempotencyRecord.deleteMany({});
  });

  // ─── markProcessing ─────────────────────────────────────────────────────────

  describe('markProcessing (Redis primary)', () => {
    it('succeeds for a new key and writes a processing record to Redis and Mongo', async () => {
      const key = newKey();

      await expect(service.markProcessing(key, ESCROW_FUND_ENDPOINT)).resolves.toBeUndefined();

      const raw = await redis.get(redisKeyFor(key, ESCROW_FUND_ENDPOINT));
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw as string)).toEqual({ status: 'processing' });
      expect(await redis.ttl(redisKeyFor(key, ESCROW_FUND_ENDPOINT))).toBe(TTL_SECONDS);

      const record = await IdempotencyRecord.findOne({
        key,
        endpoint: ESCROW_FUND_ENDPOINT,
      }).lean();
      expect(record).not.toBeNull();
      expect(record?.status).toBe('processing');
      expect(record?.responseStatus).toBeUndefined();
      expect(record?.responseBody).toBeUndefined();
    });

    it('returns a 409 conflict for a key that is already in flight', async () => {
      const key = newKey();
      await service.markProcessing(key, ESCROW_FUND_ENDPOINT);

      await expectConflict(service.markProcessing(key, ESCROW_FUND_ENDPOINT));

      // The original in-flight record must be untouched and not duplicated.
      expect(await IdempotencyRecord.countDocuments({ key, endpoint: ESCROW_FUND_ENDPOINT })).toBe(
        1,
      );
      const stored = await service.get(key, ESCROW_FUND_ENDPOINT);
      expect(stored).toEqual({ status: 'processing' });
    });

    it('lets exactly one of several concurrent requests win (NX semantics)', async () => {
      const key = newKey();

      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () => service.markProcessing(key, ESCROW_FUND_ENDPOINT)),
      );

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(4);
      rejected.forEach((r) => {
        expect(r.reason).toBeInstanceOf(AppError);
        expect((r.reason as AppError).statusCode).toBe(httpStatus.CONFLICT);
      });
      expect(await IdempotencyRecord.countDocuments({ key })).toBe(1);
    });

    it('namespaces keys by endpoint so the same key is safe across routes', async () => {
      const key = newKey();

      await service.markProcessing(key, ESCROW_FUND_ENDPOINT);
      await expect(service.markProcessing(key, DELIVERY_CREATE_ENDPOINT)).resolves.toBeUndefined();

      const records = await IdempotencyRecord.find({ key }).lean();
      expect(records.map((r) => r.endpoint).sort()).toEqual(
        [DELIVERY_CREATE_ENDPOINT, ESCROW_FUND_ENDPOINT].sort(),
      );
    });

    it('treats a failed Mongo shadow-write as non-fatal while Redis holds the lock', async () => {
      const key = newKey();
      jest
        .spyOn(IdempotencyRecord, 'create')
        .mockRejectedValueOnce(new Error('Mongo write concern timeout') as never);

      await expect(service.markProcessing(key, ESCROW_FUND_ENDPOINT)).resolves.toBeUndefined();

      expect(await redis.get(redisKeyFor(key, ESCROW_FUND_ENDPOINT))).not.toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Mongo shadow-write failed'),
        expect.any(Error),
      );
      // Redis remains authoritative: a duplicate is still rejected.
      await expectConflict(service.markProcessing(key, ESCROW_FUND_ENDPOINT));
    });
  });

  // ─── markCompleted ──────────────────────────────────────────────────────────

  describe('markCompleted', () => {
    it('stores the response and a subsequent lookup replays the same status and body', async () => {
      const key = newKey();
      const body = fundedBody(key);
      await service.markProcessing(key, ESCROW_FUND_ENDPOINT);

      await service.markCompleted(key, ESCROW_FUND_ENDPOINT, httpStatus.CREATED, body);

      const replay = await service.get(key, ESCROW_FUND_ENDPOINT);
      expect(replay).toEqual<IdempotencyPayload>({
        status: 'completed',
        responseStatus: httpStatus.CREATED,
        responseBody: body,
      });

      // The durable copy in MongoDB must be identical (used after a Redis flush).
      const record = await IdempotencyRecord.findOne({
        key,
        endpoint: ESCROW_FUND_ENDPOINT,
      }).lean();
      expect(record?.status).toBe('completed');
      expect(record?.responseStatus).toBe(httpStatus.CREATED);
      expect(record?.responseBody).toEqual(body);
    });

    it('replays from MongoDB with an identical payload when Redis has been flushed', async () => {
      const key = newKey();
      const body = fundedBody(key);
      await service.markProcessing(key, ESCROW_FUND_ENDPOINT);
      await service.markCompleted(key, ESCROW_FUND_ENDPOINT, httpStatus.CREATED, body);
      const fromRedis = await service.get(key, ESCROW_FUND_ENDPOINT);

      await redis.flushall();

      const fromMongo = await service.get(key, ESCROW_FUND_ENDPOINT);
      expect(fromMongo).toEqual(fromRedis);
    });

    it('prevents a duplicate charge: the completed key cannot be re-marked as processing', async () => {
      const key = newKey();
      await service.markProcessing(key, ESCROW_FUND_ENDPOINT);
      await service.markCompleted(key, ESCROW_FUND_ENDPOINT, httpStatus.CREATED, fundedBody(key));

      await expectConflict(service.markProcessing(key, ESCROW_FUND_ENDPOINT));

      const record = await IdempotencyRecord.findOne({
        key,
        endpoint: ESCROW_FUND_ENDPOINT,
      }).lean();
      expect(record?.status).toBe('completed');
    });

    it('logs a warning but resolves when only the Mongo update fails', async () => {
      const key = newKey();
      const body = fundedBody(key);
      await service.markProcessing(key, ESCROW_FUND_ENDPOINT);
      jest
        .spyOn(IdempotencyRecord, 'findOneAndUpdate')
        .mockRejectedValueOnce(new Error('Mongo primary stepped down') as never);

      await expect(
        service.markCompleted(key, ESCROW_FUND_ENDPOINT, httpStatus.CREATED, body),
      ).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Mongo update failed (Redis ok)'),
        expect.any(Error),
      );
      expect(errorSpy).not.toHaveBeenCalled();
      expect(await service.get(key, ESCROW_FUND_ENDPOINT)).toEqual({
        status: 'completed',
        responseStatus: httpStatus.CREATED,
        responseBody: body,
      });
    });

    it('logs an error when the completed record cannot be persisted in either store', async () => {
      const key = newKey();
      await service.markProcessing(key, ESCROW_FUND_ENDPOINT);
      redis.simulateOutage();
      jest
        .spyOn(IdempotencyRecord, 'findOneAndUpdate')
        .mockRejectedValueOnce(new Error('Mongo unreachable') as never);

      await expect(
        service.markCompleted(key, ESCROW_FUND_ENDPOINT, httpStatus.CREATED, fundedBody(key)),
      ).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to persist completed record in both stores'),
        expect.any(Error),
      );
    });
  });

  // ─── markFailed ─────────────────────────────────────────────────────────────

  describe('markFailed', () => {
    it('persists the failure response and releases the in-flight state', async () => {
      const key = newKey();
      const body = failureBody('Soroban RPC timed out while funding escrow');
      await service.markProcessing(key, ESCROW_FUND_ENDPOINT);

      await service.markFailed(key, ESCROW_FUND_ENDPOINT, httpStatus.BAD_GATEWAY, body);

      const stored = await service.get(key, ESCROW_FUND_ENDPOINT);
      expect(stored).toEqual<IdempotencyPayload>({
        status: 'failed',
        responseStatus: httpStatus.BAD_GATEWAY,
        responseBody: body,
      });
      // No longer "processing" — callers receive the stored outcome instead of a 409.
      expect(stored?.status).not.toBe('processing');

      const record = await IdempotencyRecord.findOne({
        key,
        endpoint: ESCROW_FUND_ENDPOINT,
      }).lean();
      expect(record?.status).toBe('failed');
      expect(record?.responseStatus).toBe(httpStatus.BAD_GATEWAY);
      expect(record?.responseBody).toEqual(body);
    });

    it('allows the client to retry the operation with a fresh key after a failure', async () => {
      const failedKey = newKey();
      await service.markProcessing(failedKey, ESCROW_FUND_ENDPOINT);
      await service.markFailed(
        failedKey,
        ESCROW_FUND_ENDPOINT,
        httpStatus.BAD_GATEWAY,
        failureBody('Upstream failure'),
      );

      const retryKey = newKey();
      await expect(service.markProcessing(retryKey, ESCROW_FUND_ENDPOINT)).resolves.toBeUndefined();
      const retryBody = fundedBody(retryKey);
      await service.markCompleted(retryKey, ESCROW_FUND_ENDPOINT, httpStatus.CREATED, retryBody);

      expect((await service.get(retryKey, ESCROW_FUND_ENDPOINT))?.responseBody).toEqual(retryBody);
      // The original failure record is preserved for replay.
      expect((await service.get(failedKey, ESCROW_FUND_ENDPOINT))?.status).toBe('failed');
    });

    it('allows the same key to be retried once the failed record has expired', async () => {
      const key = newKey();
      const start = Date.now();
      let nowMs = start;
      jest.spyOn(Date, 'now').mockImplementation(() => nowMs);

      await service.markProcessing(key, ESCROW_FUND_ENDPOINT);
      await service.markFailed(
        key,
        ESCROW_FUND_ENDPOINT,
        httpStatus.BAD_GATEWAY,
        failureBody('Upstream failure'),
      );
      // Same key is still guarded while the failure record is live.
      await expectConflict(service.markProcessing(key, ESCROW_FUND_ENDPOINT));

      nowMs = start + TTL_MS + 1;
      await runMongoTtlMonitor();

      await expect(service.markProcessing(key, ESCROW_FUND_ENDPOINT)).resolves.toBeUndefined();
      expect(await service.get(key, ESCROW_FUND_ENDPOINT)).toEqual({ status: 'processing' });
    });

    it('swallows a Mongo update failure and keeps the Redis record', async () => {
      const key = newKey();
      const body = failureBody('Upstream failure');
      await service.markProcessing(key, ESCROW_FUND_ENDPOINT);
      jest
        .spyOn(IdempotencyRecord, 'findOneAndUpdate')
        .mockRejectedValueOnce(new Error('Mongo unreachable') as never);

      await expect(
        service.markFailed(key, ESCROW_FUND_ENDPOINT, httpStatus.BAD_GATEWAY, body),
      ).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Mongo markFailed update failed'),
        expect.any(Error),
      );
      expect((await service.get(key, ESCROW_FUND_ENDPOINT))?.status).toBe('failed');
    });
  });

  // ─── Mongo fallback ─────────────────────────────────────────────────────────

  describe('MongoDB fallback', () => {
    describe.each([
      [
        'Redis is unreachable',
        (): void => {
          redis.simulateOutage();
        },
      ],
      [
        'Redis is not configured',
        (): void => {
          mockRedisHolder.client = null;
        },
      ],
    ])('when %s', (_label, disableRedis) => {
      beforeEach(() => {
        disableRedis();
      });

      it('markProcessing persists a processing record in MongoDB', async () => {
        const key = newKey();

        await expect(service.markProcessing(key, ESCROW_FUND_ENDPOINT)).resolves.toBeUndefined();

        const record = await IdempotencyRecord.findOne({
          key,
          endpoint: ESCROW_FUND_ENDPOINT,
        }).lean();
        expect(record?.status).toBe('processing');
        expect(await service.get(key, ESCROW_FUND_ENDPOINT)).toEqual({
          status: 'processing',
          responseStatus: undefined,
          responseBody: undefined,
        });
      });

      it('runs the full processing -> completed -> replay lifecycle from MongoDB', async () => {
        const key = newKey();
        const body = fundedBody(key);

        await service.markProcessing(key, ESCROW_FUND_ENDPOINT);
        await service.markCompleted(key, ESCROW_FUND_ENDPOINT, httpStatus.CREATED, body);

        expect(await service.get(key, ESCROW_FUND_ENDPOINT)).toEqual({
          status: 'completed',
          responseStatus: httpStatus.CREATED,
          responseBody: body,
        });
      });

      it('runs the processing -> failed lifecycle from MongoDB', async () => {
        const key = newKey();
        const body = failureBody('Upstream failure');

        await service.markProcessing(key, ESCROW_FUND_ENDPOINT);
        await service.markFailed(key, ESCROW_FUND_ENDPOINT, httpStatus.BAD_GATEWAY, body);

        expect(await service.get(key, ESCROW_FUND_ENDPOINT)).toEqual({
          status: 'failed',
          responseStatus: httpStatus.BAD_GATEWAY,
          responseBody: body,
        });
      });

      it('never overwrites an in-flight record and keeps a single document', async () => {
        const key = newKey();
        await service.markProcessing(key, ESCROW_FUND_ENDPOINT);
        const original = await IdempotencyRecord.findOne({ key }).lean();

        await service.markProcessing(key, ESCROW_FUND_ENDPOINT);

        const after = await IdempotencyRecord.find({ key }).lean();
        expect(after).toHaveLength(1);
        expect(after[0].status).toBe('processing');
        expect(after[0].expiresAt.getTime()).toBe(original?.expiresAt.getTime());
        // In-flight state is surfaced through get(), which the middleware maps to 409.
        expect((await service.get(key, ESCROW_FUND_ENDPOINT))?.status).toBe('processing');
      });

      it('does not downgrade a completed record back to processing', async () => {
        const key = newKey();
        const body = fundedBody(key);
        await service.markProcessing(key, ESCROW_FUND_ENDPOINT);
        await service.markCompleted(key, ESCROW_FUND_ENDPOINT, httpStatus.CREATED, body);

        await service.markProcessing(key, ESCROW_FUND_ENDPOINT);

        const record = await IdempotencyRecord.findOne({ key }).lean();
        expect(record?.status).toBe('completed');
        expect(record?.responseBody).toEqual(body);
      });
    });

    it('logs the Redis failure before falling back on markProcessing', async () => {
      redis.simulateOutage();

      await service.markProcessing(newKey(), ESCROW_FUND_ENDPOINT);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Redis NX error, falling back to MongoDB'),
        expect.objectContaining({ code: 'ECONNREFUSED' }),
      );
    });

    it('logs the Redis failure before falling back on get', async () => {
      const key = newKey();
      await service.markProcessing(key, ESCROW_FUND_ENDPOINT);
      redis.simulateOutage();

      expect((await service.get(key, ESCROW_FUND_ENDPOINT))?.status).toBe('processing');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Redis GET error, falling back to MongoDB'),
        expect.objectContaining({ code: 'ECONNREFUSED' }),
      );
    });

    it('logs the Redis failure before falling back on markCompleted', async () => {
      const key = newKey();
      await service.markProcessing(key, ESCROW_FUND_ENDPOINT);
      redis.simulateOutage();

      await service.markCompleted(key, ESCROW_FUND_ENDPOINT, httpStatus.CREATED, fundedBody(key));

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Redis SETEX error, falling back to MongoDB'),
        expect.objectContaining({ code: 'ECONNREFUSED' }),
      );
      expect((await IdempotencyRecord.findOne({ key }).lean())?.status).toBe('completed');
    });

    it('falls back to MongoDB when the Redis payload is corrupt', async () => {
      const key = newKey();
      const body = fundedBody(key);
      await service.markProcessing(key, ESCROW_FUND_ENDPOINT);
      await service.markCompleted(key, ESCROW_FUND_ENDPOINT, httpStatus.CREATED, body);
      await redis.setex(redisKeyFor(key, ESCROW_FUND_ENDPOINT), TTL_SECONDS, '{not-json');

      expect(await service.get(key, ESCROW_FUND_ENDPOINT)).toEqual({
        status: 'completed',
        responseStatus: httpStatus.CREATED,
        responseBody: body,
      });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Redis GET error'),
        expect.any(SyntaxError),
      );
    });

    it('serves records written during an outage after Redis recovers', async () => {
      const key = newKey();
      const body = fundedBody(key);
      redis.simulateOutage();
      await service.markProcessing(key, ESCROW_FUND_ENDPOINT);
      await service.markCompleted(key, ESCROW_FUND_ENDPOINT, httpStatus.CREATED, body);

      redis.restore();

      expect(await redis.get(redisKeyFor(key, ESCROW_FUND_ENDPOINT))).toBeNull();
      expect(await service.get(key, ESCROW_FUND_ENDPOINT)).toEqual({
        status: 'completed',
        responseStatus: httpStatus.CREATED,
        responseBody: body,
      });
    });

    it('converts a Mongo duplicate-key race (E11000) into a 409 conflict', async () => {
      mockRedisHolder.client = null;
      const duplicateKeyError = Object.assign(
        new Error('E11000 duplicate key error collection: idempotencyrecords'),
        { code: 11000 },
      );
      jest
        .spyOn(IdempotencyRecord, 'findOneAndUpdate')
        .mockRejectedValueOnce(duplicateKeyError as never);

      await expectConflict(service.markProcessing(newKey(), ESCROW_FUND_ENDPOINT));
    });

    it('rethrows unexpected Mongo errors unchanged', async () => {
      mockRedisHolder.client = null;
      const networkError = new Error('MongoNetworkError: connection reset');
      jest
        .spyOn(IdempotencyRecord, 'findOneAndUpdate')
        .mockRejectedValueOnce(networkError as never);

      await expect(service.markProcessing(newKey(), ESCROW_FUND_ENDPOINT)).rejects.toBe(
        networkError,
      );
    });

    it('returns null from get for an unknown key in both stores', async () => {
      expect(await service.get(newKey(), ESCROW_FUND_ENDPOINT)).toBeNull();
      mockRedisHolder.client = null;
      expect(await service.get(newKey(), ESCROW_FUND_ENDPOINT)).toBeNull();
    });
  });

  // ─── TTL / expiry ───────────────────────────────────────────────────────────

  describe('TTL and expiry', () => {
    let start: number;
    let nowMs: number;

    beforeEach(() => {
      start = Date.now();
      nowMs = start;
      jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
    });

    it('sets the Mongo expiresAt to now + IDEMPOTENCY_TTL_SECONDS', async () => {
      const key = newKey();

      await service.markProcessing(key, ESCROW_FUND_ENDPOINT);

      const record = await IdempotencyRecord.findOne({ key }).lean();
      expect(record?.expiresAt.getTime()).toBe(start + TTL_MS);
    });

    it('sets the same expiry on the Mongo-only fallback path', async () => {
      mockRedisHolder.client = null;
      const key = newKey();

      await service.markProcessing(key, ESCROW_FUND_ENDPOINT);

      const record = await IdempotencyRecord.findOne({ key }).lean();
      expect(record?.expiresAt.getTime()).toBe(start + TTL_MS);
    });

    it('keeps conflicting right up until the key expires', async () => {
      const key = newKey();
      await service.markProcessing(key, ESCROW_FUND_ENDPOINT);

      nowMs = start + TTL_MS - 1;

      await expectConflict(service.markProcessing(key, ESCROW_FUND_ENDPOINT));
      expect(await redis.ttl(redisKeyFor(key, ESCROW_FUND_ENDPOINT))).toBe(1);
    });

    it('treats an expired key as new: lookup misses and processing can restart', async () => {
      const key = newKey();
      await service.markProcessing(key, ESCROW_FUND_ENDPOINT);
      await service.markCompleted(key, ESCROW_FUND_ENDPOINT, httpStatus.CREATED, fundedBody(key));

      nowMs = start + TTL_MS + 1;
      expect(await redis.get(redisKeyFor(key, ESCROW_FUND_ENDPOINT))).toBeNull();
      await runMongoTtlMonitor();

      expect(await IdempotencyRecord.countDocuments({ key })).toBe(0);
      expect(await service.get(key, ESCROW_FUND_ENDPOINT)).toBeNull();
      await expect(service.markProcessing(key, ESCROW_FUND_ENDPOINT)).resolves.toBeUndefined();
    });

    it('still replays from MongoDB after the Redis key expires but before Mongo purges it', async () => {
      const key = newKey();
      const body = fundedBody(key);
      await service.markProcessing(key, ESCROW_FUND_ENDPOINT);
      nowMs = start + 1_000;
      await service.markCompleted(key, ESCROW_FUND_ENDPOINT, httpStatus.CREATED, body);

      // Redis entry (written at start + 1s) has expired; Mongo TTL monitor has not run yet.
      nowMs = start + 1_000 + TTL_MS + 1;

      expect(await redis.get(redisKeyFor(key, ESCROW_FUND_ENDPOINT))).toBeNull();
      expect(await service.get(key, ESCROW_FUND_ENDPOINT)).toEqual({
        status: 'completed',
        responseStatus: httpStatus.CREATED,
        responseBody: body,
      });
    });

    it('resets the TTL in both stores when the request completes', async () => {
      const key = newKey();
      await service.markProcessing(key, ESCROW_FUND_ENDPOINT);

      const completedAt = start + TTL_MS / 2;
      nowMs = completedAt;
      await service.markCompleted(key, ESCROW_FUND_ENDPOINT, httpStatus.CREATED, fundedBody(key));

      expect(await redis.ttl(redisKeyFor(key, ESCROW_FUND_ENDPOINT))).toBe(TTL_SECONDS);
      const record = await IdempotencyRecord.findOne({ key }).lean();
      expect(record?.expiresAt.getTime()).toBe(completedAt + TTL_MS);

      // Past the original expiry but within the refreshed window, the key is still guarded.
      nowMs = start + TTL_MS + 1;
      await runMongoTtlMonitor();
      expect((await service.get(key, ESCROW_FUND_ENDPOINT))?.status).toBe('completed');
      await expectConflict(service.markProcessing(key, ESCROW_FUND_ENDPOINT));
    });

    it('declares a MongoDB TTL index on expiresAt so records are purged automatically', async () => {
      const indexes = await IdempotencyRecord.collection.indexes();

      const ttlIndex = indexes.find((idx) => idx.key && idx.key.expiresAt === 1);
      expect(ttlIndex).toBeDefined();
      expect(ttlIndex?.expireAfterSeconds).toBe(0);

      const uniqueIndex = indexes.find(
        (idx) => idx.key && idx.key.key === 1 && idx.key.endpoint === 1,
      );
      expect(uniqueIndex?.unique).toBe(true);
    });
  });
});
