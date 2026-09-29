import env from '../config/env';
import logger from '../config/logger';
import { getRedisClient } from '../config/redis';
import { buildEtaCacheKey } from '../utils/etaCacheKey';
import { Coordinates, ETAResponse, TravelMode } from '../types/routing.types';
import env from '../config/env';

export interface EtaCacheLookup {
  pickup: Coordinates;
  dropoff: Coordinates;
  travelMode: TravelMode;
  geohashPrecision?: number;
}

/**
 * Redis-backed cache for ETA calculation results.
 * Keeps external routing API usage down for frequently requested routes.
 */
export class EtaCacheService {
  private readonly ttlSeconds: number;
  private readonly geohashPrecision: number;

  constructor(options?: { ttlSeconds?: number; geohashPrecision?: number }) {
    this.ttlSeconds = options?.ttlSeconds ?? this.readTtlSeconds();
    this.geohashPrecision = options?.geohashPrecision ?? this.readGeohashPrecision();
  }

  /**
   * Look up a cached ETA for the given route coordinates.
   * Returns null on cache miss or when Redis is unavailable.
   */
  async get(lookup: EtaCacheLookup): Promise<ETAResponse | null> {
    const redis = getRedisClient();
    if (!redis) {
      return null;
    }

    const key = buildEtaCacheKey(
      lookup.pickup,
      lookup.dropoff,
      lookup.travelMode,
      lookup.geohashPrecision ?? this.geohashPrecision,
    );

    try {
      const raw = await redis.get(key);
      if (!raw) {
        logger.debug(`[EtaCache] Miss — key=${key}`);
        return null;
      }

      const parsed = JSON.parse(raw) as ETAResponse;
      logger.debug(`[EtaCache] Hit — key=${key}`);
      return parsed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[EtaCache] Read failed — key=${key}: ${message}`);
      return null;
    }
  }

  /**
   * Store an ETA result with TTL. Failures are logged but do not propagate.
   */
  async set(lookup: EtaCacheLookup, value: ETAResponse): Promise<void> {
    const redis = getRedisClient();
    if (!redis) {
      return;
    }

    const key = buildEtaCacheKey(
      lookup.pickup,
      lookup.dropoff,
      lookup.travelMode,
      lookup.geohashPrecision ?? this.geohashPrecision,
    );

    try {
      await redis.set(key, JSON.stringify(value), 'EX', this.ttlSeconds);
      logger.debug(`[EtaCache] Stored — key=${key} ttl=${this.ttlSeconds}s`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[EtaCache] Write failed — key=${key}: ${message}`);
    }
  }

  private readTtlSeconds(): number {
    return env.ETA_CACHE_TTL_SECONDS;
  }

  private readGeohashPrecision(): number {
    return env.ETA_GEOHASH_PRECISION;
  }
}

export const etaCacheService = new EtaCacheService();
