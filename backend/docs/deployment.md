# SwiftChain Backend Deployment Guide

## Overview

This guide covers production deployment and operation of the SwiftChain backend, including Docker services, environment configuration, health checks, graceful shutdown, logging, database persistence, Redis, and operational commands.

## Prerequisites

* Docker Engine
* Docker Compose
* Node.js 18+ for the current Docker image
* Node.js 22+ for the documented local development target
* pnpm
* Access to the required MongoDB, Redis, and Stellar/Soroban configuration

> **Repository note:** `Dockerfile` currently uses `node:18-alpine` and `npm install`, while the repository also contains `pnpm-lock.yaml`. Do not assume the Dockerfile has already migrated to Node 22/pnpm until that source configuration is changed.

## Docker Deployment

The repository provides three Docker Compose services:

| Service | Image / Build      |    Port | Purpose                                    |
| ------- | ------------------ | ------: | ------------------------------------------ |
| `app`   | Local `Dockerfile` |  `5000` | SwiftChain API                             |
| `mongo` | `mongo:latest`     | `27017` | MongoDB persistence                        |
| `redis` | `redis:7-alpine`   |  `6379` | Caching, idempotency and distributed locks |

All services join the `swiftchain-network` bridge network.

MongoDB persists data through:

```yaml
volumes:
  - mongo-data:/data/db
```

The named `mongo-data` volume must be preserved across application container restarts.

### Start the stack

```bash
docker compose up -d --build
```

Check service status:

```bash
docker compose ps
```

Follow application logs:

```bash
docker compose logs -f app
```

Stop the stack:

```bash
docker compose down
```

Do not use `docker compose down -v` in an environment containing data that must be preserved because it removes named volumes.

## Environment Configuration

Copy the repository environment template:

```bash
cp .env.example .env
```

Environment variables are validated at application startup by `src/config/env.ts`. Invalid values cause startup validation to fail.

### Core configuration

```env
NODE_ENV=production
PORT=3000
APP_BASE_URL=https://api.example.com
MONGODB_URI=mongodb://localhost:27017/swiftchain
REDIS_URL=redis://localhost:6379
```

### Authentication and security

```env
JWT_SECRET=<strong-production-secret>
JWT_EXPIRES_IN=7d
BCRYPT_ROUNDS=10
CORS_ORIGIN=https://app.example.com
```

`JWT_SECRET` must be replaced with a strong production-only secret.

### Stellar / Soroban

```env
STELLAR_NETWORK=testnet
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
SOROBAN_RPC_TIMEOUT_MS=10000
STELLAR_BASE_FEE=100
STELLAR_TRANSACTION_TIMEOUT_SECONDS=300
```

Supported network aliases are:

* `testnet`
* `mainnet`
* `futurenet`

The configured `STELLAR_NETWORK`, `SOROBAN_RPC_URL`, and optional network passphrase must refer to the same network.

### Redis and locking

Redis is used for:

* ETA cache
* `Idempotency-Key` records
* Redlock distributed locking
* Admin dashboard metric caching

Relevant configuration includes:

```env
REDIS_URL=redis://localhost:6379
REDIS_LOCK_TTL_MS=10000
REDIS_LOCK_RETRY_COUNT=3
REDIS_LOCK_RETRY_DELAY_MS=200
IDEMPOTENCY_TTL_SECONDS=86400
```

### Storage

For local storage:

```env
UPLOAD_STORAGE_DRIVER=local
```

For S3:

```env
UPLOAD_STORAGE_DRIVER=s3
AWS_S3_BUCKET=<bucket>
AWS_REGION=<region>
AWS_S3_SIGNED_URL_EXPIRES_SECONDS=3600
```

When using S3, the required bucket and region configuration must be supplied.

## Health Checks

Health routes are mounted under `/api/v1/health` in the current source tree.

### Comprehensive health check

```http
GET /api/v1/health
```

The endpoint checks:

* MongoDB connection state and live ping
* Stellar/Soroban RPC connectivity
* RPC circuit-breaker behavior

Successful response:

```json
{
  "success": true,
  "data": {
    "status": "healthy",
    "services": {
      "mongodb": {
        "status": "healthy"
      },
      "stellarRpc": {
        "status": "healthy"
      }
    },
    "timestamp": "2026-09-30T00:00:00.000Z",
    "uptime": 123.45
  },
  "error": null,
  "message": "All services are healthy"
}
```

HTTP `200` means all required checks are healthy.

HTTP `503` means one or more dependencies are degraded.

### Circuit-breaker health

```http
GET /api/v1/health/circuit-breakers
```

This reports the runtime state and statistics of registered circuit breakers.

HTTP `200` indicates all monitored breakers are closed.

HTTP `206` indicates one or more breakers are open or half-open.

### Container health checks

A deployment platform can use `/api/v1/health` as the application readiness/liveness endpoint:

```text
http://<host>:<port>/api/v1/health
```

Treat HTTP `200` as healthy and HTTP `503` as degraded.

## Graceful Shutdown

Graceful shutdown is implemented by:

```text
src/services/gracefulShutdownService.ts
```

The server registers handlers for:

```text
SIGTERM
SIGINT
```

The shutdown timeout is controlled by:

```env
SHUTDOWN_TIMEOUT_MS=30000
```

The default timeout is 30 seconds.

### Shutdown order

The service follows this order:

1. Begin request draining.
2. Stop background jobs and pollers.
3. Stop accepting new HTTP connections.
4. Wait for in-flight HTTP requests.
5. Drain Socket.IO connections.
6. Wait for active MongoDB transactions.
7. Disconnect MongoDB.
8. Exit successfully.

The implementation also prevents concurrent shutdown sequences from racing when multiple signals are received.

### Timeout behavior

If the shutdown sequence exceeds `SHUTDOWN_TIMEOUT_MS`, the process logs a timeout and exits with code `1`.

Expected downtime depends on the deployment platform and replacement strategy. A single-instance deployment can experience a short interruption while the old process drains and the replacement starts. A rolling or multi-instance deployment can avoid externally visible downtime when traffic is shifted before termination.

## Logging

Logging is centralized in:

```text
src/config/logger.ts
```

Winston provides:

* console logging
* structured JSON production output
* PII masking
* daily file rotation
* size-based rotation
* compressed archives
* retention-based cleanup

The logging configuration is controlled by environment values such as:

```env
LOG_LEVEL=info
```

The logger creates rotating files when file logging is enabled:

```text
error-%DATE%.log
all-%DATE%.log
```

The exact directory, maximum file size, retention count, archive compression, and file-disable behavior are controlled through the validated logging configuration in `src/config/env.ts`.

### Recommended log shipping

Production deployments should ship rotated logs to a centralized system such as:

* CloudWatch Logs
* Datadog
* Grafana Loki
* Elastic Stack
* another managed log aggregation service

Do not rely exclusively on container-local log files because containers may be replaced or deleted.

## MongoDB Persistence

MongoDB is the primary persistent datastore.

Docker Compose uses:

```yaml
volumes:
  - mongo-data:/data/db
```

Back up the MongoDB volume/database according to the production recovery policy.

The application should not be considered healthy solely because the MongoDB process is running. `/api/v1/health` performs an actual MongoDB ping.

## Redis Operations

Redis supports non-primary application state including:

* caching
* idempotency records
* distributed locks
* admin dashboard cache

Redis availability is therefore operationally important even though MongoDB remains the primary persistent datastore.

## Production Build and Start

Install dependencies:

```bash
pnpm install
```

Build TypeScript:

```bash
pnpm build
```

Start the compiled application:

```bash
pnpm start
```

The repository currently defines:

```json
{
  "build": "tsc",
  "start": "node dist/server.js"
}
```

The development server is:

```bash
pnpm dev
```

## Seed and One-Off Commands

The seed script is:

```bash
pnpm seed
```

It executes:

```text
src/seed.ts
```

Before running a seed or maintenance command against production, verify the configured `MONGODB_URI` and deployment environment.

Other useful commands:

```bash
pnpm lint
pnpm test
pnpm test:coverage
pnpm format
```

## Operational Checklist

Before production rollout:

* [ ] Configure production `NODE_ENV`.
* [ ] Set a strong `JWT_SECRET`.
* [ ] Configure production `MONGODB_URI`.
* [ ] Configure production `REDIS_URL`.
* [ ] Configure `STELLAR_NETWORK`.
* [ ] Configure `SOROBAN_RPC_URL`.
* [ ] Configure storage/S3 when required.
* [ ] Configure CORS origins.
* [ ] Configure shutdown timeout.
* [ ] Configure log level and retention.
* [ ] Confirm MongoDB persistence/backups.
* [ ] Confirm Redis availability.
* [ ] Verify `/api/v1/health`.
* [ ] Verify `/api/v1/health/circuit-breakers`.
* [ ] Confirm centralized log shipping.
* [ ] Test SIGTERM shutdown behavior before the first production rollout.
