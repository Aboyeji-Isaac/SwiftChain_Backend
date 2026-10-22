# SwiftChain Backend Development Setup

## Prerequisites

Install the following:

* Node.js 22+
* pnpm
* MongoDB, or Docker
* Redis, or Docker
* Git

Optional for blockchain development:

* Stellar/Soroban RPC access
* FCM service account for push notifications
* AWS S3 credentials when using S3 storage
* Google Maps API key for external routing

## Clone the Repository

```bash
git clone https://github.com/SwiftChainn/SwiftChain_Backend.git
cd SwiftChain_Backend
```

## Install Dependencies

The repository includes a pnpm workspace/lockfile.

Install dependencies with:

```bash
pnpm install
```

The repository's package scripts include:

```bash
pnpm dev
pnpm build
pnpm start
pnpm seed
pnpm lint
pnpm test
pnpm test:coverage
```

## Environment Setup

Copy the example environment file:

```bash
cp .env.example .env
```

The environment schema is implemented in:

```text
src/config/env.ts
```

The application validates environment variables during startup.

A useful local baseline is:

```env
NODE_ENV=development
PORT=3000
APP_BASE_URL=http://localhost:3000

MONGODB_URI=mongodb://localhost:27017/swiftchain
REDIS_URL=redis://localhost:6379

JWT_SECRET=local_dev_only_jwt_secret_change_me_32chars
JWT_EXPIRES_IN=7d
BCRYPT_ROUNDS=10

CORS_ORIGIN=http://localhost:3000,http://localhost:5173

UPLOAD_STORAGE_DRIVER=local

STELLAR_NETWORK=testnet
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org

LOG_LEVEL=info
SHUTDOWN_TIMEOUT_MS=30000
```

Do not commit `.env`.

## MongoDB

### Local MongoDB

Start MongoDB using your operating system's MongoDB service and use:

```env
MONGODB_URI=mongodb://localhost:27017/swiftchain
```

### Docker MongoDB

The repository's Compose file provides MongoDB:

```bash
docker compose up -d mongo
```

The Compose service exposes MongoDB on:

```text
localhost:27017
```

The Docker network hostname is:

```text
mongo
```

Inside Docker Compose, the application can therefore use:

```text
mongodb://mongo:27017/swiftchain
```

## Redis

Redis is required for several application capabilities, including:

* ETA caching
* idempotency
* Redlock distributed locking
* admin dashboard caching

Start Redis locally:

```bash
redis-server
```

or with Docker:

```bash
docker compose up -d redis
```

Local configuration:

```env
REDIS_URL=redis://localhost:6379
```

Docker Compose configuration:

```env
REDIS_URL=redis://redis:6379
```

## Start the Full Local Infrastructure

MongoDB and Redis can be started together:

```bash
docker compose up -d mongo redis
```

Check status:

```bash
docker compose ps
```

## Stellar / Soroban Configuration

The backend supports:

```text
testnet
mainnet
futurenet
```

For development, testnet is the normal default:

```env
STELLAR_NETWORK=testnet
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
```

Futurenet can be selected with:

```env
STELLAR_NETWORK=futurenet
SOROBAN_RPC_URL=https://rpc-futurenet.stellar.org
```

When using a custom RPC provider, set:

```env
SOROBAN_RPC_URL=<provider-rpc-url>
```

The network alias and RPC endpoint must refer to the same Stellar network.

## Soroban RPC Unavailability

The application uses circuit breakers and retry logic around Soroban RPC operations.

If the RPC endpoint becomes unavailable:

* RPC calls can fail or be retried according to configured retry values.
* The circuit breaker can transition from `CLOSED` to `OPEN`.
* Subsequent calls can be rejected while the dependency is unavailable.
* The application can report degraded blockchain health rather than treating the entire process as healthy.

Check:

```http
GET /api/v1/health
```

and:

```http
GET /api/v1/health/circuit-breakers
```

Relevant configuration includes:

```env
SOROBAN_RPC_MAX_RETRIES=3
SOROBAN_RPC_RETRY_BASE_MS=250
SOROBAN_RPC_RETRY_MAX_MS=8000

CB_SOROBAN_ERROR_THRESHOLD_PERCENTAGE=50
CB_SOROBAN_ROLLING_WINDOW_MS=30000
CB_SOROBAN_RESET_TIMEOUT_MS=60000
CB_SOROBAN_VOLUME_THRESHOLD=5
CB_SOROBAN_TIMEOUT_MS=10000
```

## Run the Development Server

Start the development server:

```bash
pnpm dev
```

The repository currently runs:

```text
nodemon --exec ts-node src/server.ts
```

The API is normally available on:

```text
http://localhost:3000
```

Verify the service:

```bash
curl http://localhost:3000/api/v1/health
```

## Build the Application

Compile TypeScript:

```bash
pnpm build
```

This produces the compiled application under the configured TypeScript output directory.

Start the compiled server:

```bash
pnpm start
```

The current package script is:

```text
node dist/server.js
```

## Seed Data

Run the seed script with:

```bash
pnpm seed
```

The script executes:

```text
src/seed.ts
```

Confirm the active `MONGODB_URI` before running it.

## Linting and Formatting

Run ESLint:

```bash
pnpm lint
```

Run Prettier:

```bash
pnpm format
```

## Testing

Run the complete test suite:

```bash
pnpm test
```

Run tests with coverage:

```bash
pnpm test:coverage
```

For focused development, Jest can also be invoked with its normal filtering options.

## Local Health Verification

After starting MongoDB, Redis and the API:

```bash
curl http://localhost:3000/api/v1/health
```

Expected healthy state:

```json
{
  "success": true,
  "data": {
    "status": "healthy"
  }
}
```

A `503` response indicates that one or more required services are degraded.

Check circuit breakers separately:

```bash
curl http://localhost:3000/api/v1/health/circuit-breakers
```

## Common Pitfalls

### Redis is not running

Symptoms can include:

* Redlock acquisition failures
* cache misses
* idempotency storage failures
* dashboard cache failures

Check:

```bash
redis-cli ping
```

Expected:

```text
PONG
```

If using Docker:

```bash
docker compose ps redis
docker compose logs redis
```

### Environment validation failure

If startup exits immediately, inspect the validation output.

Common causes include:

* invalid `PORT`
* invalid `NODE_ENV`
* invalid `STELLAR_NETWORK`
* malformed URLs
* invalid numeric configuration
* missing required S3 configuration when `UPLOAD_STORAGE_DRIVER=s3`

Start from:

```bash
cp .env.example .env
```

and change values incrementally.

### MongoDB connection failure

Verify:

```bash
mongosh
```

or:

```bash
docker compose ps mongo
docker compose logs mongo
```

Then confirm:

```env
MONGODB_URI=mongodb://localhost:27017/swiftchain
```

### `mongodb-memory-server` first-run download

Tests that use `mongodb-memory-server` may download MongoDB binaries during their first run.

The first test execution can therefore be slower and may require network access.

If the binary download fails:

1. Check network connectivity.
2. Retry the test.
3. Confirm the required binary can be downloaded.
4. Avoid interpreting the first-run download delay as an application test timeout unless the test actually exceeds its configured timeout.

### Soroban RPC unavailable

Check:

```bash
curl http://localhost:3000/api/v1/health
curl http://localhost:3000/api/v1/health/circuit-breakers
```

Then verify:

```env
STELLAR_NETWORK=testnet
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
```

### Port already in use

Change:

```env
PORT=3000
```

to another available port, for example:

```env
PORT=3001
```

Then restart the development server.

## Recommended Local Workflow

```bash
# 1. Start infrastructure
docker compose up -d mongo redis

# 2. Install dependencies
pnpm install

# 3. Configure environment
cp .env.example .env

# 4. Start development server
pnpm dev

# 5. Verify health
curl http://localhost:3000/api/v1/health

# 6. Run tests
pnpm test

# 7. Run coverage
pnpm test:coverage

# 8. Check lint
pnpm lint
```

## Development Checklist

* [ ] Node.js 22+ installed.
* [ ] pnpm installed.
* [ ] MongoDB running.
* [ ] Redis running.
* [ ] `.env` created from `.env.example`.
* [ ] Stellar network configured.
* [ ] Soroban RPC reachable.
* [ ] `pnpm install` completed.
* [ ] `pnpm dev` starts successfully.
* [ ] `/api/v1/health` reports the expected state.
* [ ] Tests pass.
* [ ] Lint passes.
