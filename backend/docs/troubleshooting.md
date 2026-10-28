# SwiftChain Backend Troubleshooting and FAQ

## Environment Validation

Environment variables are validated by:

```text
src/config/env.ts
```

The configuration uses Zod.

When validation fails, the application prints:

```text
❌ Invalid environment variables:
  - VARIABLE_NAME: <validation message>
```

For example:

```text
❌ Invalid environment variables:
  - JWT_SECRET: String must contain at least 16 character(s)
```

The process exits after validation failure.

### Common Zod Problems

#### Numeric values

Environment variables arrive as strings.

The project generally handles numeric environment variables using Zod coercion:

```typescript
z.coerce.number()
```

For example:

```typescript
SOROBAN_RPC_TIMEOUT_MS: z.coerce
  .number()
  .int()
  .min(1000)
  .default(10000)
```

Use numeric text in `.env`:

```env
SOROBAN_RPC_TIMEOUT_MS=10000
```

Avoid malformed values:

```env
SOROBAN_RPC_TIMEOUT_MS=ten-seconds
```

#### Boolean values

Some configuration values use explicit string-to-boolean transformation:

```typescript
LOG_ZIPPED_ARCHIVE: z
  .enum(['true', 'false'])
  .default('true')
  .transform((value) => value === 'true')
```

Use:

```env
LOG_ZIPPED_ARCHIVE=true
```

or:

```env
LOG_ZIPPED_ARCHIVE=false
```

Do not use arbitrary values such as:

```env
LOG_ZIPPED_ARCHIVE=yes
```

---

## Redis Problems

Redis is configured in:

```text
src/config/redis.ts
```

The default Redis URL is:

```env
REDIS_URL=redis://localhost:6379
```

Redis is used for distributed locking and related infrastructure.

Redlock configuration includes:

```env
REDIS_LOCK_TTL_MS=10000
REDIS_LOCK_RETRY_COUNT=3
REDIS_LOCK_RETRY_DELAY_MS=200
```

### Symptoms of Redis Being Down

Common symptoms include:

```text
Redis connection errors
Redlock acquisition errors
lock acquisition failures
reconnection messages
```

The Redis client logs connection events through the application logger.

### Fix

Start Redis locally:

```bash
redis-server
```

or start the project's configured Docker Redis service if available.

Then verify:

```env
REDIS_URL=redis://localhost:6379
```

Restart the backend after correcting the configuration.

### Idempotency Behavior

The delivery creation flow uses:

```text
src/middlewares/idempotency.ts
src/services/idempotency.service.ts
```

MongoDB-backed idempotency persistence is available through the application's idempotency service/model.

Redis should therefore not be treated as the only persistence layer for idempotency behavior.

---

## Stellar / Soroban RPC Timeouts

Stellar/Soroban configuration is validated in:

```text
src/config/env.ts
```

Relevant settings include:

```env
SOROBAN_RPC_URL=
SOROBAN_RPC_TIMEOUT_MS=10000
SOROBAN_RPC_MAX_RETRIES=3
SOROBAN_RPC_RETRY_BASE_MS=250
SOROBAN_RPC_RETRY_MAX_MS=8000
```

A slow or unavailable RPC provider can cause:

```text
RPC timeout errors
retry activity
circuit breaker state changes
degraded health responses
```

First verify:

```env
SOROBAN_RPC_URL=<valid RPC endpoint>
```

Then verify that the RPC provider is reachable from the runtime environment.

---

## Circuit Breakers

Circuit breaker configuration includes:

```env
CB_SOROBAN_ERROR_THRESHOLD_PERCENTAGE=50
CB_SOROBAN_ROLLING_WINDOW_MS=30000
CB_SOROBAN_RESET_TIMEOUT_MS=60000
CB_SOROBAN_VOLUME_THRESHOLD=5
CB_SOROBAN_TIMEOUT_MS=10000
```

The health endpoint exposes circuit breaker state:

```text
GET /api/v1/health/circuit-breakers
```

The route is implemented in:

```text
src/routes/healthRoutes.ts
```

The response reports states such as:

```text
closed
open
halfOpen
```

HTTP behavior is:

```text
200 -> all registered breakers are closed
206 -> one or more breakers are open or half-open
```

Example:

```bash
curl http://localhost:3000/api/v1/health/circuit-breakers
```

A circuit breaker returning to normal depends on the configured reset behavior and successful calls to the protected dependency.

---

## Health Checks

The comprehensive health endpoint is:

```text
GET /api/v1/health
```

The lightweight application liveness endpoint is:

```text
GET /health
```

The comprehensive endpoint checks application dependencies including MongoDB and Stellar/Soroban RPC.

Use:

```bash
curl http://localhost:3000/health
```

for basic process availability.

Use:

```bash
curl http://localhost:3000/api/v1/health
```

for dependency health.

---

## Known Build Issues

The indexer service is currently implemented at:

```text
src/services/indexerService.ts
```

The current implementation imports the socket helper from:

```typescript
import { emitDeliveryStatusUpdated } from '../sockets';
```

Therefore, troubleshooting should first verify that the `src/sockets` module and its exported `emitDeliveryStatusUpdated` symbol are available before treating an indexer import failure as a generic TypeScript failure.

Run:

```bash
pnpm build
```

and inspect the exact TypeScript/module-resolution error.

Do not create a duplicate `webSocketService` implementation merely to silence an import error.

---

## MongoDB Memory Server

Jest initializes test mode through:

```text
tests/jest.setup.ts
```

MongoDB Memory Server may download its MongoDB binary on the first test execution.

The first run can therefore be slower than later runs.

If tests appear stuck during initialization:

1. Check network access.
2. Check whether the MongoDB binary download is blocked.
3. Run the test again after the binary has been cached.
4. Check available disk space.
5. Avoid repeatedly deleting the MongoDB Memory Server cache.

---

## MongoDB Connection Exhaustion

MongoDB connection exhaustion can appear as:

```text
connection pool timeout
server selection timeout
operations waiting for a connection
slow database operations
```

Check:

```env
MONGODB_URI=
```

and verify the MongoDB server is reachable.

For local development:

```bash
mongosh
```

can be used to confirm connectivity.

Avoid creating a new MongoDB connection for every request or test.

The application's existing database configuration should manage the shared connection lifecycle.

---

## Logging

Logging is centralized in:

```text
src/config/logger.ts
```

The log directory is configured through:

```env
LOG_DIR=logs
```

Other relevant settings include:

```env
LOG_MAX_SIZE=20m
LOG_MAX_FILES=14d
LOG_ZIPPED_ARCHIVE=true
LOG_DISABLE_FILE=false
```

The logger writes console output and, outside test mode, rotating files when file logging is enabled.

Expected log files include:

```text
logs/error-YYYY-MM-DD.log
logs/all-YYYY-MM-DD.log
```

---

## Debug Logging

The logger supports:

```text
error
warn
info
http
debug
```

Set:

```env
LOG_LEVEL=debug
```

when detailed diagnostic output is required.

After changing `.env`, restart the application.

Do not commit credentials, private keys, JWT secrets, or production environment values into the repository.

---

## FAQ

### Why does `/api/v1/...` return 404?

Check:

```text
src/app.ts
src/routes/index.ts
```

The application must contain:

```typescript
app.use('/api', routes);
```

and the endpoint's router must be mounted under `/v1`.

### Why does a route file exist but the endpoint return 404?

A route file existing under:

```text
src/routes/
```

does not automatically make it public.

Verify its `router.use(...)` registration in:

```text
src/routes/index.ts
```

### Why does `pnpm test` take longer on the first run?

MongoDB Memory Server may need to download its MongoDB binary.

### Why does `pnpm test:coverage` fail?

Check the layer-specific thresholds in:

```text
jest.config.js
```

Services require 80% coverage, while global coverage requires 60%.

### Why does a Stellar operation fail after repeated RPC errors?

Check:

```text
GET /api/v1/health/circuit-breakers
```

The Soroban RPC circuit breaker may be `open` or `halfOpen`.

### Why is the build failing around the indexer?

Check the exact TypeScript error and verify the socket exports consumed by:

```text
src/services/indexerService.ts
```

### Where should application logs be checked?

Check:

```text
logs/
```

when file logging is enabled, or the process console when running locally.

---

## Diagnostic Checklist

```text
1. Check .env values.
2. Check MongoDB connectivity.
3. Check Redis connectivity.
4. Check Soroban RPC connectivity.
5. Check /health.
6. Check /api/v1/health.
7. Check /api/v1/health/circuit-breakers.
8. Check logs/.
9. Run pnpm lint.
10. Run pnpm build.
11. Run the affected Jest test.
12. Run pnpm test:coverage when appropriate.
```
