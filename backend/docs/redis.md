# Redis Usage and Caching Architecture Reference

## Overview

Redis is SwiftChain's shared in-memory store for three jobs:

1. **Distributed locking** — Redlock guards the critical sections that must not
   run twice at the same time (escrow release, driver assignment).
2. **Short-lived caching** — ETA results and the admin dashboard metrics.
3. **Ephemeral coordination** — idempotency records and driver-location
   deduplication.

Redis is *not* a source of truth. Every value stored here is either derivable
again (caches), has a durable fallback (idempotency → MongoDB), or is a guard
whose absence degrades semantics rather than losing committed data. No Redis
key is the only record of a business fact.

Primary implementation files:

```text
src/config/redis.ts                 client, Redlock, initializeRedis/disconnectRedis, withLock
src/services/etaCacheService.ts     ETA result cache
src/utils/etaCacheKey.ts            ETA cache key builder
src/services/idempotency.service.ts Idempotency-Key records (Redis + MongoDB)
src/middlewares/idempotency.ts      HTTP middleware that drives the service
src/models/IdempotencyRecord.ts     MongoDB fallback model + TTL index
src/sockets/location.service.ts     driver-location dedup and last-seen tracking
src/services/dashboardService.ts    admin dashboard metrics cache
src/services/escrow.service.ts      escrow release critical section
src/services/assignmentService.ts   driver assignment critical section
src/server.ts                       connection lifecycle
src/config/env.ts                   configuration and defaults
```

---

## Consumer inventory

Every Redis key in the codebase, its shape, its TTL, and its failure mode.

| Subsystem | Key pattern | TTL | Commands | If Redis is unavailable |
|---|---|---|---|---|
| ETA cache | `eta:<pickupGeohash>:<dropoffGeohash>:<travelMode>` | `ETA_CACHE_TTL_SECONDS` (default 600s) | `GET`, `SET … EX` | **Fail open:** cache miss, ETA recomputed from the routing provider |
| Idempotency store | `idempotency:<METHOD:baseUrl+path>:<idempotency-key>` | `IDEMPOTENCY_TTL_SECONDS` (default 86400s) | `GET`, `SETEX`, `SET … EX NX` | **Fall back to MongoDB** (`idempotencyrecords`, TTL index) |
| Escrow release lock | `escrow:release:<escrowId>` (Redlock resource) | `REDIS_LOCK_TTL_MS` (default 10000ms) | Redlock acquire/release | **Fail closed:** release aborts with an error |
| Driver assignment lock | `assignment:delivery:<deliveryId>` (Redlock resource) | `REDIS_LOCK_TTL_MS` (default 10000ms) | Redlock acquire/release | **Fail closed:** assignment aborts with an error |
| Location dedup | `location:dedup:<driverId>:<deliveryId>:<capturedAt>:<lat>:<lng>` | `LOCATION_DEDUP_TTL_SECONDS` (default 60s) | `SET … EX NX` | **Fail open:** update accepted, duplicate not suppressed |
| Location last-seen | `location:last:<driverId>:<deliveryId>` | `LOCATION_DEDUP_TTL_SECONDS × 2` (default 120s) | `GET`, `SET … EX` | **Fail open:** stale check skipped |
| Admin dashboard cache | `admin:dashboard:metrics` | `ADMIN_DASHBOARD_CACHE_TTL_SECONDS` (default 60s) | `GET`, `SET … EX` | **Fail open:** metrics recomputed from MongoDB/Soroban |

> **Not Redis (despite the "queues" wording in older notes):** the Socket.IO
> message queue in `src/sockets/messageQueue.ts` is an **in-process `Map`**.
> It is not persisted and is not shared across instances; a restart drops it.
> Driver availability claims in `src/services/assignmentService.ts` are atomic
> **MongoDB** `findOneAndUpdate` operations, not Redis keys. Neither should be
> documented or reasoned about as a Redis consumer.

---

## Key namespace convention

New keys must follow the existing colon-separated, lowercase convention:

```text
<domain>:<entity>[:<id>][:<qualifier>...]
```

Rules:

- **Lowercase, colon-separated.** No spaces, no slashes, no mixed case.
- **Domain first.** Current domains: `eta`, `idempotency`, `escrow`,
  `assignment`, `location`, `admin`. Reuse one before inventing another.
- **Most specific value last.** Put variable identifiers (`driverId`,
  `deliveryId`, `escrowId`) before derived qualifiers, as
  `location:dedup:…:<capturedAt>:<lat>:<lng>` does.
- **Always set a TTL.** With the sole exception of the Redlock keys (whose TTL
  is the lock lease), no key may be written without an expiry — an untimed key
  is an unbounded leak.
- **Use `NX` for dedup and first-writer-wins.** `SET key value EX ttl NX` is the
  established pattern for "claim once".
- **Never encode secrets** (tokens, passwords, PII) in a key: keys are visible
  in `MONITOR`, `KEYS`, and slow-log output. Credentials embedded in
  `REDIS_URL` are already redacted by `src/utils/piiMasker.ts` when logged.

Worked examples:

```text
eta:9q8y0v8:9q8y0v9:DRIVING
idempotency:POST:/api/v1/escrow/release:1b4e28ba-2fa1-11d2-883f-0016d3cca427
escrow:release:507f1f77bcf86cd799439011
assignment:delivery:507f1f77bcf86cd799439012
location:dedup:64b7…:64b8…:1725700000000:37.774929:-122.419418
location:last:64b7…:64b8…
admin:dashboard:metrics
```

---

## Connection lifecycle and settings

`src/config/redis.ts` creates a single shared `ioredis` client at module load:

```ts
export const redisClient = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    return Math.min(times * 50, 2000); // linear backoff, capped at 2s
  },
  lazyConnect: true,
});
```

- **`lazyConnect: true`** — the client does not open a socket until
  `initializeRedis()` calls `connect()`. Importing the module therefore never
  triggers network I/O.
- **`maxRetriesPerRequest: 3`** — a command fails after three retries instead of
  hanging, which is what lets the idempotency and cache layers fall back
  promptly.
- **Reconnect** is automatic via `retryStrategy`; the client logs
  `error`, `connect`, `ready`, and `reconnecting` events through Winston.

### Startup

`src/server.ts` calls `initializeRedis()` after the HTTP server starts:

```ts
await initializeRedis();
```

- **Production:** a failed connection exits the process (`process.exit(1)`).
- **Non-production:** the failure is logged, a warning is emitted, and the
  server continues so local development does not require Redis.

### Shutdown

`SIGINT`/`SIGTERM` trigger `disconnectRedis()`, which calls `redisClient.quit()`
and logs the result. Socket shutdown and process exit proceed regardless of the
quit outcome.

---

## Redlock distributed locking

Redlock is configured in `src/config/redis.ts`:

```ts
export const redlock = new Redlock([redisClient], {
  driftFactor: 0.01,
  retryCount: env.REDIS_LOCK_RETRY_COUNT,      // default 3
  retryDelay: env.REDIS_LOCK_RETRY_DELAY_MS,   // default 200ms
  retryJitter: 100,
  automaticExtensionThreshold: 500,
});
```

> **Single-node caveat:** Redlock currently runs against one Redis instance.
> The algorithm's safety guarantee assumes a majority of independent nodes; with
> one node the lock is only as available as that node. The factory is written to
> accept more clients when a multi-node deployment is introduced.

### Operations that take a lock

| Operation | Resource key | Held across |
|---|---|---|
| Escrow release (`escrow.service.ts#releaseEscrow`) | `escrow:release:<escrowId>` | status guards, transaction-hash idempotency check, on-chain settlement bookkeeping |
| Driver assignment (`assignmentService.ts#assignNearestDriver`) | `assignment:delivery:<deliveryId>` | delivery lookup, radius expansion, driver claim and assignment write |

Both use the `withLock(resource, fn)` helper, which acquires the lock, runs the
critical section, and releases the lock in a `finally` block — including when
the section throws.

### TTL and retry behaviour

- **Lock TTL** defaults to `REDIS_LOCK_TTL_MS` (10000ms). A lock that is never
  released still auto-expires after the TTL, so a crashed holder cannot deadlock
  the resource permanently.
- **Contention:** if another holder owns the lock, Redlock retries up to
  `REDIS_LOCK_RETRY_COUNT` times, waiting `REDIS_LOCK_RETRY_DELAY_MS` (+ up to
  100ms jitter) between attempts. `automaticExtensionThreshold: 500` extends the
  lease automatically while long critical sections are still running.
- **Exhaustion:** when every retry fails, `acquireLock` throws
  `Failed to acquire lock for <resource>: <cause>`, which propagates to the
  caller. Escrow release surfaces this as a server error; assignment records it
  and leaves the delivery for the next sweep. **Locks fail closed** — the
  critical section does not run without the lock.

The critical sections are still written to be idempotent (the escrow release
checks the transaction hash before mutating), so a lock that expires mid-work
cannot double-apply a settlement.

---

## Failure behaviour per subsystem

- **ETA cache (`etaCacheService`)** — `get` returns `null` on a miss or any read
  error; `set` swallows write errors after logging. Redis down simply means
  every ETA is computed live. **Fail open.**
- **Admin dashboard cache (`dashboardService`)** — a read or write error is
  logged and the metrics are aggregated from MongoDB and Soroban. The response
  always carries `metadata.cached` so callers can tell whether a cache was used.
  **Fail open.**
- **Idempotency (`idempotency.service`)** — the service prefers Redis and falls
  back to MongoDB on any error:
  - `markProcessing` uses `SET … EX NX`; a `null` reply (key already existed)
    throws `409 Conflict`. If Redis itself errors, the Mongo
    `findOneAndUpdate(..., { upsert: true })` path provides the same
    insert-if-absent guarantee (duplicate key `11000` → `409`).
  - `markCompleted` / `markFailed` write both stores; a completed record is only
    best-effort in Mongo when Redis succeeded, and a **loud error is logged if
    both stores fail** because idempotency can no longer be guaranteed.
  - MongoDB records expire via a TTL index on `expiresAt`
    (`expireAfterSeconds: 0`), mirroring the Redis TTL. **Fail over to Mongo.**
- **Driver-location dedup (`location.service`)** — both the duplicate check and
  the stale check catch Redis errors and **allow** the update, logging a
  warning. Redis down means duplicate tolerance returns to the timestamp checks
  only. **Fail open.**
- **Redlock locks** — **fail closed**, as described above.

The asymmetry is deliberate: caches and dedup guards are optimisations and must
never take the API down, whereas a lock protects a value-moving critical section
and must refuse to run if it cannot coordinate.

---

## Configuration reference

Set in `.env` (see `.env.example` for inline descriptions):

| Variable | Default | Used by |
|---|---|---|
| `REDIS_URL` | `redis://localhost:6379` | all consumers |
| `REDIS_LOCK_TTL_MS` | `10000` | Redlock |
| `REDIS_LOCK_RETRY_COUNT` | `3` | Redlock |
| `REDIS_LOCK_RETRY_DELAY_MS` | `200` | Redlock |
| `IDEMPOTENCY_TTL_SECONDS` | `86400` | idempotency store |
| `ETA_CACHE_TTL_SECONDS` | `600` | ETA cache |
| `ETA_GEOHASH_PRECISION` | `7` | ETA cache key |
| `LOCATION_DEDUP_TTL_SECONDS` | `60` | location dedup / last-seen |
| `ADMIN_DASHBOARD_CACHE_TTL_SECONDS` | `60` | dashboard cache (read from `process.env`, not the Zod schema) |

---

## Troubleshooting

| Symptom | Likely cause | Resolution |
|---|---|---|
| `[Redis] Failed to connect` / `ECONNREFUSED`; process exits in production | Redis not running or `REDIS_URL` wrong | Start Redis (`redis-cli ping` → `PONG`) and verify `REDIS_URL`; in non-production the server starts without it but locks are unavailable |
| `Failed to acquire lock for escrow:release:…` / assignment fails intermittently | A release or assignment is holding the lock longer than the TTL, or Redis is slow | Confirm the critical section is bounded; raise `REDIS_LOCK_TTL_MS`, `REDIS_LOCK_RETRY_COUNT`, or `REDIS_LOCK_RETRY_DELAY_MS`; inspect with `redis-cli --scan --pattern 'escrow:release:*'` |
| Stale locks linger after a crash | Holder died before `finally` ran | Expected: keys expire after `REDIS_LOCK_TTL_MS`. No manual cleanup is required; do not delete a live lock |
| `OOM command not allowed when used memory > 'maxmemory'` | Redis reached its `maxmemory` under an eviction policy that rejects writes | Size the instance, set `maxmemory-policy allkeys-lru` (every key here is regenerable), and confirm all new keys carry a TTL |
| Keys accumulate without bound (`SCAN` shows a growing pattern) | A key was written without an expiry | Re-check the key against the convention above; add the missing TTL in code, then `UNLINK` the offenders |
| Idempotency replays stop after a Redis flush | Expected — the Mongo fallback still holds completed records until their TTL | No action; verify `idempotencyrecords` TTL index exists |
| Duplicate location updates accepted | Redis dedup degraded (fail open) | Restore Redis connectivity; the behavior is intentional so a cache outage cannot halt ingest |

Diagnostics:

```bash
redis-cli ping
redis-cli info memory
redis-cli --scan --pattern 'location:*'
redis-cli ttl escrow:release:<escrowId>
```

---

## Adding a new Redis consumer

1. Pick a key in the `<domain>:<entity>[:<id>][:<qualifier>]` namespace and a
   TTL; add both to `src/config/env.ts` (and `.env.example`) if configurable.
2. Decide and document the failure mode explicitly: **fail open** for caches and
   best-effort dedup, **fail closed** only when correctness of a value-moving
   operation depends on the guard.
3. Wrap every command in `try/catch` and log with the subsystem prefix (e.g.
   `[EtaCache]`, `[IdempotencyService]`) so a degraded Redis is visible.
4. Use `SET … EX NX` for claim/dedup semantics and a Lua script or `WATCH`/`MULTI`
   if a read-modify-write must be atomic.
5. Add a test for the Redis-unavailable path, not only the happy path.

---

## Source of truth

```text
src/config/redis.ts
src/config/env.ts
src/server.ts
src/services/etaCacheService.ts
src/utils/etaCacheKey.ts
src/services/idempotency.service.ts
src/middlewares/idempotency.ts
src/models/IdempotencyRecord.ts
src/sockets/location.service.ts
src/services/dashboardService.ts
src/services/escrow.service.ts
src/services/assignmentService.ts
REDIS_REDLOCK_IMPLEMENTATION.md
```
