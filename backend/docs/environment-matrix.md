# Environment Configuration Matrix

## Purpose

This document defines how SwiftChain Backend configuration differs between development, test/CI, staging, and production.

The canonical environment schema is:

```text
src/config/env.ts
```

The example configuration is:

```text
.env.example
```

CI configuration is defined in:

```text
.github/workflows/ci.yml
```

---

## 1. Environment Matrix

| Configuration                | Development                | Test / CI                                                | Staging                  | Production                  |
| ---------------------------- | -------------------------- | -------------------------------------------------------- | ------------------------ | --------------------------- |
| `NODE_ENV`                   | `development`              | `test`                                                   | `production`             | `production`                |
| `MONGODB_URI`                | Local MongoDB              | CI MongoDB                                               | Managed staging MongoDB  | Managed production MongoDB  |
| `JWT_SECRET`                 | Local-only secret          | CI secret/test value                                     | Deployment secret        | Deployment secret           |
| `CORS_ORIGIN`                | Local frontend             | Test origin                                              | Staging frontend         | Production frontend         |
| `RATE_LIMIT_MAX_REQUESTS`    | Development value          | Disabled/bypassed by test configuration where applicable | Staging limit            | Production limit            |
| `REDIS_URL`                  | Local Redis                | CI/test Redis                                            | Managed Redis            | Managed Redis               |
| `UPLOAD_STORAGE_DRIVER`      | `local`                    | `local`                                                  | `s3`                     | `s3`                        |
| `AWS_REGION`                 | Local/default              | Test value                                               | Deployment configuration | Deployment configuration    |
| `AWS_ACCESS_KEY_ID`          | Provider/local credentials | CI secret if required                                    | Secret manager           | Secret manager              |
| `AWS_SECRET_ACCESS_KEY`      | Provider/local credentials | CI secret if required                                    | Secret manager           | Secret manager              |
| `FCM_PROJECT_ID`             | Optional                   | Test/blank                                               | Staging Firebase project | Production Firebase project |
| `FCM_CLIENT_EMAIL`           | Optional                   | Test/blank                                               | Secret                   | Secret                      |
| `FCM_PRIVATE_KEY`            | Optional                   | Test/blank                                               | Secret                   | Secret                      |
| `STELLAR_NETWORK`            | `testnet`                  | `testnet`/test configuration                             | `testnet`                | `mainnet`                   |
| `SOROBAN_RPC_URL`            | Testnet/default            | Testnet/default                                          | Staging RPC              | Production RPC              |
| `STELLAR_NETWORK_PASSPHRASE` | Testnet                    | Testnet                                                  | Staging network          | Mainnet                     |
| `SOROBAN_ESCROW_CONTRACT_ID` | Development contract       | Test contract                                            | Staging contract         | Production contract         |
| `CB_SOROBAN_*`               | Fast feedback values       | Stable test values                                       | Production-like          | Production tuning           |
| `INDEXER_LAG_*`              | Development values         | Test-safe values                                         | Alerting enabled         | Alerting enabled            |
| `WEBHOOK_*`                  | Local/test endpoints       | CI-safe endpoints                                        | Staging endpoints        | Production endpoints        |
| `GOOGLE_MAPS_API_KEY`        | Optional                   | Optional                                                 | Secret                   | Secret                      |
| `OPENWEATHER_API_KEY`        | Optional                   | Optional                                                 | Secret                   | Secret                      |
| `APP_BASE_URL`               | `http://localhost:3000`    | CI URL/test value                                        | Staging URL              | Production URL              |

Example values are intentionally non-secret. Actual deployment values must be supplied by the environment rather than committed to source control.

---

## 2. CI Environment

The current workflow is:

```text
.github/workflows/ci.yml
```

It currently uses:

```yaml
strategy:
  matrix:
    node-version: [22.x]
    mongodb-version: ['6.0']
```

MongoDB is started inside the GitHub Actions runner:

```yaml
- name: Start MongoDB
  uses: supercharge/mongodb-github-action@1.11.0
  with:
    mongodb-version: ${{ matrix.mongodb-version }}
```

Tests receive CI-specific values:

```yaml
env:
  CI: true
  MONGO_URI: mongodb://localhost:27017/swiftchain_test
  JWT_SECRET: test-secret-key-16chars
```

Do not copy CI credentials or test database URLs into staging or production configuration.

---

## 3. NODE_ENV Behaviour

`NODE_ENV` is validated by `src/config/env.ts`:

```text
development
test
production
```

Use:

| Value         | Intended use                         |
| ------------- | ------------------------------------ |
| `development` | Local development and debugging      |
| `test`        | Automated tests and CI               |
| `production`  | Staging/production runtime behaviour |

Configuration-dependent behaviour should be determined from `NODE_ENV` rather than hard-coding environment names throughout the application.

Typical differences include:

* error detail/verbosity
* logger formatting
* CORS policy
* background-job startup
* external-service configuration
* security defaults

---

## 4. Secret Management

The following values must never contain real credentials in Git:

* `JWT_SECRET`
* `AWS_ACCESS_KEY_ID`
* `AWS_SECRET_ACCESS_KEY`
* `FCM_PRIVATE_KEY`
* `FCM_CLIENT_EMAIL`
* `FCM_PROJECT_ID` where treated as confidential by deployment policy
* `GOOGLE_MAPS_API_KEY`
* `OPENWEATHER_API_KEY`
* private webhook credentials
* database credentials embedded in `MONGODB_URI`
* private Stellar/Soroban credentials

`.env.example` must contain placeholders or safe development values only.

Production secrets should be injected by the deployment platform's secret/environment-variable mechanism.

---

## 5. Adding a New Environment Variable

Every new configuration value must follow this sequence:

```text
1. Add validation/default to src/config/env.ts
              ↓
2. Add safe example to .env.example
              ↓
3. Add the variable to this matrix
              ↓
4. Determine whether CI requires it
              ↓
5. Add CI injection only when required
              ↓
6. Document production secret injection
              ↓
7. Run lint/build/tests
```

### Example

For a new variable:

```text
NEW_FEATURE_TIMEOUT_MS
```

Update:

```text
src/config/env.ts
.env.example
backend/docs/environment-matrix.md
.github/workflows/ci.yml
```

Only modify CI when the variable is required for tests or builds.

---

## 6. Environment Safety Rules

* Never commit production secrets.
* Never use production MongoDB credentials locally.
* Never point CI at production infrastructure.
* Never point the demo seed script at production.
* Keep Stellar network and passphrase values consistent.
* Use separate storage credentials per environment.
* Use separate Firebase projects/credentials where environment isolation is required.
* Use environment-specific webhook endpoints.
* Verify `NODE_ENV` before running administrative commands.
* Review environment changes as part of deployment review.

---

## 7. Configuration Validation

The application validates environment variables through Zod during startup.

A missing or invalid value should cause startup failure rather than allowing the application to run with an invalid configuration.

Before deployment:

```bash
pnpm run lint
pnpm run build
pnpm test
pnpm run test:coverage
```

Then verify the deployed service health endpoint and relevant external integrations.
