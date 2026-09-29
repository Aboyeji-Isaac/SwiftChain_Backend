import httpStatus from 'http-status-codes';
import { redisClient } from '../config/redis';
import IdempotencyRecord, { IdempotencyStatus } from '../models/IdempotencyRecord';
import env from '../config/env';
import logger from '../config/logger';
import { AppError } from '../utils/AppError';
import { toUTC } from '../utils/dateUtils';

/** Payload stored against an idempotency key once a request completes. */
export interface IdempotencyPayload {
  status: IdempotencyStatus;
  responseStatus?: number;
  responseBody?: Record<string, unknown>;
}

/**
 * IdempotencyService provides a thin store-agnostic API over two backends:
 *
 *  1. **Redis** (preferred) — used when `REDIS_URL` is configured.
 *     Keys are stored as JSON strings with a TTL set by `IDEMPOTENCY_TTL_SECONDS`.
 *  2. **MongoDB** (fallback) — used when Redis is unavailable or not configured.
 *     Records are stored in the `idempotencyrecords` collection with a TTL index.
 *
 * The service is called exclusively from `idempotencyMiddleware` and is never
 * called directly from controllers or other services — it sits at the
 * infrastructure layer.
 */
export class IdempotencyService {
  private readonly ttlSeconds: number;

  constructor() {
    this.ttlSeconds = env.IDEMPOTENCY_TTL_SECONDS;
  }

  // ─── Redis helpers ──────────────────────────────────────────────────────────

  private redisKey(key: string, endpoint: string): string {
    return `idempotency:${endpoint}:${key}`;
  }

  private async getFromRedis(key: string, endpoint: string): Promise<IdempotencyPayload | null> {
    if (!redisClient) return null;
    try {
      const raw = await redisClient.get(this.redisKey(key, endpoint));
      if (!raw) return null;
      return JSON.parse(raw) as IdempotencyPayload;
    } catch (err) {
      logger.warn('[IdempotencyService] Redis GET error, falling back to MongoDB:', err);
      return null;
    }
  }

  private async setInRedis(
    key: string,
    endpoint: string,
    payload: IdempotencyPayload,
  ): Promise<boolean> {
    if (!redisClient) return false;
    try {
      await redisClient.setex(
        this.redisKey(key, endpoint),
        this.ttlSeconds,
        JSON.stringify(payload),
      );
      return true;
    } catch (err) {
      logger.warn('[IdempotencyService] Redis SETEX error, falling back to MongoDB:', err);
      return false;
    }
  }

  private async updateInRedis(
    key: string,
    endpoint: string,
    payload: IdempotencyPayload,
  ): Promise<boolean> {
    // Reuse setex — it resets the TTL, which is acceptable here.
    return this.setInRedis(key, endpoint, payload);
  }

  // ─── MongoDB helpers ────────────────────────────────────────────────────────

  private expiresAt(): Date {
    return toUTC(Date.now() + this.ttlSeconds * 1000);
  }

  private async getFromMongo(key: string, endpoint: string): Promise<IdempotencyPayload | null> {
    const record = await IdempotencyRecord.findOne({ key, endpoint });
    if (!record) return null;
    return {
      status: record.status,
      responseStatus: record.responseStatus,
      responseBody: record.responseBody,
    };
  }

  private async setInMongo(
    key: string,
    endpoint: string,
    payload: IdempotencyPayload,
  ): Promise<void> {
    await IdempotencyRecord.create({
      key,
      endpoint,
      status: payload.status,
      responseStatus: payload.responseStatus,
      responseBody: payload.responseBody,
      expiresAt: this.expiresAt(),
    });
  }

  private async updateInMongo(
    key: string,
    endpoint: string,
    payload: IdempotencyPayload,
  ): Promise<void> {
    await IdempotencyRecord.findOneAndUpdate(
      { key, endpoint },
      {
        $set: {
          status: payload.status,
          responseStatus: payload.responseStatus,
          responseBody: payload.responseBody,
          expiresAt: this.expiresAt(),
        },
      },
      { new: true },
    );
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Look up an existing idempotency record.
   *
   * Returns `null` when no record exists for the given key/endpoint pair,
   * meaning the request is being seen for the first time.
   */
  async get(key: string, endpoint: string): Promise<IdempotencyPayload | null> {
    // Try Redis first; fall back to Mongo transparently.
    const fromRedis = await this.getFromRedis(key, endpoint);
    if (fromRedis) return fromRedis;
    return this.getFromMongo(key, endpoint);
  }

  /**
   * Mark a request as in-flight by creating a `processing` record.
   *
   * Uses an upsert guard so that two concurrent identical requests cannot
   * both pass the "first time" check — the second write fails with a
   * duplicate-key error which the middleware converts to a 409.
   *
   * @throws AppError(409) when a record already exists (duplicate concurrent request).
   */
  async markProcessing(key: string, endpoint: string): Promise<void> {
    const payload: IdempotencyPayload = { status: 'processing' };

    // Attempt Redis write first.
    if (redisClient) {
      try {
        // NX = only set if key does Not eXist.
        const result = await redisClient.set(
          this.redisKey(key, endpoint),
          JSON.stringify(payload),
          'EX',
          this.ttlSeconds,
          'NX',
        );
        if (result === null) {
          // Key already existed — a concurrent request beat us to it.
          throw new AppError(
            'A request with this Idempotency-Key is already being processed. ' +
              'Please wait and retry.',
            httpStatus.CONFLICT,
          );
        }
        // Also persist in Mongo so the record survives a Redis flush.
        await this.setInMongo(key, endpoint, payload).catch((mongoErr) => {
          // Non-fatal if Mongo write fails here — Redis is the authoritative store.
          logger.warn('[IdempotencyService] Mongo shadow-write failed:', mongoErr);
        });
        return;
      } catch (err) {
        if (err instanceof AppError) throw err;
        // Redis unavailable — fall through to Mongo-only path.
        logger.warn('[IdempotencyService] Redis NX error, falling back to MongoDB:', err);
      }
    }

    // MongoDB-only path: use findOneAndUpdate with upsert to get atomic
    // insert-if-not-exists semantics.
    try {
      await IdempotencyRecord.findOneAndUpdate(
        { key, endpoint },
        {
          $setOnInsert: {
            key,
            endpoint,
            status: 'processing' as IdempotencyStatus,
            expiresAt: this.expiresAt(),
          },
        },
        { upsert: true, new: false },
      );
    } catch (err: unknown) {
      // Mongoose duplicate-key error (code 11000) means another request already
      // inserted the record — treat it as a concurrent duplicate.
      const mongoErr = err as { code?: number };
      if (mongoErr?.code === 11000) {
        throw new AppError(
          'A request with this Idempotency-Key is already being processed. ' +
            'Please wait and retry.',
          httpStatus.CONFLICT,
        );
      }
      throw err;
    }
  }

  /**
   * Persist the completed response so future duplicates can be replayed.
   */
  async markCompleted(
    key: string,
    endpoint: string,
    responseStatus: number,
    responseBody: Record<string, unknown>,
  ): Promise<void> {
    const payload: IdempotencyPayload = {
      status: 'completed',
      responseStatus,
      responseBody,
    };

    const savedInRedis = await this.updateInRedis(key, endpoint, payload);
    await this.updateInMongo(key, endpoint, payload).catch((err) => {
      if (!savedInRedis) {
        // If both stores fail we cannot guarantee idempotency — log loudly.
        logger.error(
          '[IdempotencyService] Failed to persist completed record in both stores:',
          err,
        );
      } else {
        logger.warn('[IdempotencyService] Mongo update failed (Redis ok):', err);
      }
    });
  }

  /**
   * Persist a failed-request record.  Future duplicates will receive the
   * same error response rather than re-executing the request.
   */
  async markFailed(
    key: string,
    endpoint: string,
    responseStatus: number,
    responseBody: Record<string, unknown>,
  ): Promise<void> {
    const payload: IdempotencyPayload = {
      status: 'failed',
      responseStatus,
      responseBody,
    };

    await this.updateInRedis(key, endpoint, payload);
    await this.updateInMongo(key, endpoint, payload).catch((err) => {
      logger.warn('[IdempotencyService] Mongo markFailed update failed:', err);
    });
  }
}

export const idempotencyService = new IdempotencyService();
