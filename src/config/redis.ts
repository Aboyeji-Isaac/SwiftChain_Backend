import Redis from 'ioredis';
import Redlock, { Lock } from 'redlock';
import env from './env';
import logger from './logger';

/**
 * Redis client instance for distributed locking and caching.
 * Configured to reconnect automatically on connection loss.
 */
export const redisClient = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryStrategy(times: number): number | null {
    const delay = Math.min(times * 50, 2000);
    logger.debug(`[Redis] Reconnect attempt ${times} after ${delay}ms`);
    return delay;
  },
  lazyConnect: true,
});

/**
 * Helper to safely get the active Redis client.
 */
export function getRedisClient(): Redis | null {
  return redisClient;
}

/**
 * Redlock instance for distributed lock management across multiple Redis nodes.
 * Currently configured with a single Redis instance, but can be extended to
 * support multiple Redis clusters for higher availability.
 *
 * Lock settings:
 * - TTL: Configured via REDIS_LOCK_TTL_MS (default 10s)
 * - Retry count: Configured via REDIS_LOCK_RETRY_COUNT (default 3)
 * - Retry delay: Configured via REDIS_LOCK_RETRY_DELAY_MS (default 200ms)
 */
export const redlock = new Redlock([redisClient], {
  driftFactor: 0.01,
  retryCount: env.REDIS_LOCK_RETRY_COUNT,
  retryDelay: env.REDIS_LOCK_RETRY_DELAY_MS,
  retryJitter: 100,
  automaticExtensionThreshold: 500,
});

/**
 * Initialize Redis connection and register event handlers.
 * Should be called during application startup.
 */
export const initializeRedis = async (): Promise<void> => {
  try {
    await redisClient.connect();
    logger.info(`[Redis] Connected to ${env.REDIS_URL}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Redis] Failed to connect: ${message}`);
    throw error;
  }
};

/**
 * Gracefully disconnect Redis client.
 * Should be called during application shutdown.
 */
export const disconnectRedis = async (): Promise<void> => {
  try {
    await redisClient.quit();
    logger.info('[Redis] Disconnected');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Redis] Error during disconnect: ${message}`);
  }
};

// Event handlers for Redis client
redisClient.on('error', (error) => {
  logger.error('[Redis] Connection error:', error);
});

redisClient.on('connect', () => {
  logger.debug('[Redis] Connection established');
});

redisClient.on('ready', () => {
  logger.debug('[Redis] Client ready');
});

redisClient.on('reconnecting', () => {
  logger.warn('[Redis] Reconnecting...');
});

// Event handlers for Redlock
redlock.on('error', (error) => {
  // This is expected when lock acquisition fails, so we log at debug level
  logger.debug('[Redlock] Lock error:', error.message);
});

/**
 * Utility type for lock acquisition options.
 */
export interface LockOptions {
  /** Lock time-to-live in milliseconds. Defaults to REDIS_LOCK_TTL_MS. */
  ttl?: number;
  /** Retry count for acquiring the lock. Defaults to REDIS_LOCK_RETRY_COUNT. */
  retryCount?: number;
  /** Retry delay in milliseconds. Defaults to REDIS_LOCK_RETRY_DELAY_MS. */
  retryDelay?: number;
}

/**
 * Acquire a distributed lock with the given resource key.
 *
 * @param resource - Unique identifier for the resource to lock (e.g., `escrow:release:${escrowId}`)
 * @param options - Lock acquisition options
 * @returns Promise resolving to the acquired lock
 * @throws Error if lock cannot be acquired after all retries
 *
 * @example
 * const lock = await acquireLock(`escrow:release:${escrowId}`);
 * try {
 *   // Perform critical section work
 * } finally {
 *   await lock.release();
 * }
 */
export const acquireLock = async (resource: string, options: LockOptions = {}): Promise<Lock> => {
  const ttl = options.ttl ?? env.REDIS_LOCK_TTL_MS;
  const retryCount = options.retryCount ?? env.REDIS_LOCK_RETRY_COUNT;
  const retryDelay = options.retryDelay ?? env.REDIS_LOCK_RETRY_DELAY_MS;

  logger.debug(
    `[Redlock] Acquiring lock for resource: ${resource} (TTL: ${ttl}ms, retries: ${retryCount})`,
  );

  try {
    const lock = await redlock.acquire([resource], ttl, {
      retryCount,
      retryDelay,
    });

    logger.debug(`[Redlock] Lock acquired for resource: ${resource}`);
    return lock;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.warn(`[Redlock] Failed to acquire lock for resource: ${resource} - ${message}`);
    throw new Error(`Failed to acquire lock for ${resource}: ${message}`);
  }
};

/**
 * Execute a function within a distributed lock context.
 * Automatically acquires the lock, executes the function, and releases the lock.
 *
 * @param resource - Unique identifier for the resource to lock
 * @param fn - Async function to execute within the lock
 * @param options - Lock acquisition options
 * @returns Promise resolving to the function's return value
 *
 * @example
 * const result = await withLock(`escrow:release:${escrowId}`, async () => {
 *   return await releaseEscrow(escrowId);
 * });
 */
export const withLock = async <T>(
  resource: string,
  fn: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> => {
  const lock = await acquireLock(resource, options);

  try {
    return await fn();
  } finally {
    try {
      await lock.release();
      logger.debug(`[Redlock] Lock released for resource: ${resource}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.warn(`[Redlock] Error releasing lock for resource: ${resource} - ${message}`);
    }
  }
};

export default {
  redisClient,
  redlock,
  initializeRedis,
  disconnectRedis,
  acquireLock,
  withLock,
};
