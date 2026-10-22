/**
 * InMemoryRedis
 *
 * A small, strongly-typed, in-process stand-in for the subset of the ioredis
 * API used by `IdempotencyService` (`get`, `set ... EX ttl NX`, `setex`, `ttl`,
 * `del`, `flushall`).
 *
 * It faithfully models the semantics that matter for idempotency safety:
 *  - `SET ... NX` only writes when the key does not exist (returns `null` otherwise).
 *  - Every write carries a TTL and keys become invisible once it elapses.
 *  - `SETEX` overwrites the value and resets the TTL.
 *
 * Time is read from an injectable clock so tests can deterministically move
 * past a key's expiry without sleeping. An outage switch makes every command
 * reject with a connection error, which is how a real ioredis client behaves
 * when the server is unreachable (`maxRetriesPerRequest` exhausted).
 */

export type Clock = () => number;

interface StoredEntry {
  value: string;
  /** Absolute expiry in epoch milliseconds. */
  expiresAtMs: number;
}

export class RedisUnavailableError extends Error {
  public readonly code = 'ECONNREFUSED';

  constructor() {
    super('connect ECONNREFUSED 127.0.0.1:6379');
    this.name = 'RedisUnavailableError';
  }
}

export class InMemoryRedis {
  private readonly store = new Map<string, StoredEntry>();
  private unavailable = false;
  public readonly status: string = 'ready';

  constructor(private readonly clock: Clock = Date.now) {}

  /** Simulate the Redis server going down (all commands reject). */
  public simulateOutage(): void {
    this.unavailable = true;
  }

  /** Restore connectivity after `simulateOutage()`. */
  public restore(): void {
    this.unavailable = false;
  }

  public async get(key: string): Promise<string | null> {
    this.assertAvailable();
    const entry = this.liveEntry(key);
    return entry ? entry.value : null;
  }

  /**
   * Supports the `SET key value EX seconds NX` form used by the service, as
   * well as a plain `SET key value [EX seconds]`.
   */
  public async set(
    key: string,
    value: string,
    ...args: Array<string | number>
  ): Promise<'OK' | null> {
    this.assertAvailable();

    const upper = args.map((a) => (typeof a === 'string' ? a.toUpperCase() : a));
    const nx = upper.includes('NX');
    const exIndex = upper.indexOf('EX');
    const ttlSeconds = exIndex >= 0 ? Number(upper[exIndex + 1]) : Number.POSITIVE_INFINITY;

    if (nx && this.liveEntry(key)) {
      return null;
    }

    this.store.set(key, { value, expiresAtMs: this.clock() + ttlSeconds * 1000 });
    return 'OK';
  }

  public async setex(key: string, ttlSeconds: number, value: string): Promise<'OK'> {
    this.assertAvailable();
    this.store.set(key, { value, expiresAtMs: this.clock() + ttlSeconds * 1000 });
    return 'OK';
  }

  /** Remaining TTL in whole seconds; `-2` when the key does not exist (Redis semantics). */
  public async ttl(key: string): Promise<number> {
    this.assertAvailable();
    const entry = this.liveEntry(key);
    if (!entry) return -2;
    return Math.ceil((entry.expiresAtMs - this.clock()) / 1000);
  }

  public async del(...keys: string[]): Promise<number> {
    this.assertAvailable();
    let count = 0;
    for (const key of keys) {
      if (this.store.delete(key)) count++;
    }
    return count;
  }

  public async keys(pattern: string): Promise<string[]> {
    this.assertAvailable();
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    const matched: string[] = [];
    for (const key of this.store.keys()) {
      if (this.liveEntry(key) && regex.test(key)) {
        matched.push(key);
      }
    }
    return matched;
  }

  public async flushall(): Promise<'OK'> {
    this.store.clear();
    return 'OK';
  }

  private liveEntry(key: string): StoredEntry | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAtMs <= this.clock()) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  private assertAvailable(): void {
    if (this.unavailable) {
      throw new RedisUnavailableError();
    }
  }
}
