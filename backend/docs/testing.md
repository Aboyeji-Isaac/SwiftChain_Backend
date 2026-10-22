# SwiftChain Backend Testing Guide

## Overview

SwiftChain Backend uses Jest with `ts-jest` for automated testing.

The main commands are:

```bash
pnpm test
pnpm test:coverage
pnpm test:mutation
```

The repository also contains a dedicated k6 load-testing project under:

```text
load-tests/
```

---

## Test Layout

Tests are organized by execution scope.

```text
tests/
├── integration/
├── jest.setup.ts
└── *.test.ts
```

The repository currently contains integration tests under:

```text
tests/integration/
```

Examples include:

```text
tests/integration/auth.flow.integration.test.ts
tests/integration/dashboard.integration.test.ts
tests/integration/delivery.flow.integration.test.ts
tests/integration/deliveryEta.test.ts
tests/integration/deliveryQrCode.test.ts
tests/integration/socketLocation.test.ts
```

Unit-style tests are also present directly under `tests/`.

The repository does not currently contain a separate:

```text
tests/unit/
tests/e2e/
```

directory structure, so contributors should not create those directories merely to satisfy a naming convention. Follow the existing test organization unless the project explicitly adopts separate directories.

---

## Unit Tests

Unit tests isolate a single function, class, service, middleware, validator, or utility.

Typical targets include:

```text
src/services/
src/controllers/
src/middleware/
src/middlewares/
src/utils/
src/validators/
```

A unit test should avoid unnecessary external dependencies.

Example:

```typescript
import { describe, expect, it } from '@jest/globals';

describe('ExampleService', () => {
  it('returns the expected value', () => {
    const value = 2 + 2;

    expect(value).toBe(4);
  });
});
```

---

## Integration Tests

Integration tests exercise multiple application layers together.

Existing examples include:

```text
tests/integration/auth.flow.integration.test.ts
tests/integration/delivery.flow.integration.test.ts
tests/integration/deliveryEta.test.ts
```

Use integration tests when the behavior depends on combinations such as:

```text
route -> controller -> service -> database
```

or:

```text
authentication -> authorization -> route -> persistence
```

---

## End-to-End Tests

An end-to-end test should validate a complete externally observable workflow.

If an end-to-end test is added, place it according to the project's currently adopted test directory convention rather than assuming `tests/e2e/` exists.

A typical workflow is:

```text
client request
    ↓
Express route
    ↓
middleware
    ↓
controller
    ↓
service
    ↓
repository/model
    ↓
HTTP response
```

---

## MongoDB Memory Server

The Jest setup file is:

```text
tests/jest.setup.ts
```

It establishes test-mode environment values:

```typescript
process.env.NODE_ENV = 'test';
process.env.MONGOMS_DOWNLOAD_PROGRESS = '0';

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 16) {
  process.env.JWT_SECRET = 'test-secret-key-16chars';
}
```

Tests that use `mongodb-memory-server` may require the MongoDB binary to be downloaded the first time they run.

This means a first test execution can take longer than subsequent runs.

If the binary cannot be downloaded, verify:

* Internet access is available.
* The MongoDB binary version is supported.
* The environment allows the binary cache directory.
* Proxy/firewall rules permit the download.

---

## Jest Configuration

The main configuration is:

```text
jest.config.js
```

Important settings include:

```javascript
testEnvironment: 'node',
setupFiles: ['<rootDir>/tests/jest.setup.ts'],
testTimeout: 30000,
testPathIgnorePatterns: ['/node_modules/', '/dist/'],
```

The current Jest timeout is **30 seconds**, not 120 seconds.

The timeout is intentionally high enough for database-backed tests and MongoDB Memory Server startup.

To run all tests:

```bash
pnpm test
```

---

## Coverage Thresholds

Run coverage with:

```bash
pnpm test:coverage
```

Coverage is collected from:

```text
src/**/*.ts
```

while excluding:

```text
*.d.ts
src/**/index.ts
src/server.ts
src/seed.ts
```

Current thresholds are:

| Scope           | Branches | Functions | Lines | Statements |
| --------------- | -------: | --------: | ----: | ---------: |
| Global          |      60% |       60% |   60% |        60% |
| `src/services/` |      80% |       80% |   80% |        80% |
| `src/models/`   |      70% |       70% |   70% |        70% |
| `src/routes/`   |      60% |       60% |   60% |        60% |

Coverage reports are written to:

```text
coverage/
```

Available reporters include:

```text
text
lcov
json-summary
```

---

## Mutation Testing with Stryker

Mutation testing is configured in:

```text
stryker.conf.json
```

Run it with:

```bash
pnpm test:mutation
```

Stryker uses Jest as its test runner.

The mutation scope is:

```text
src/services/**/*.ts
```

Test files are excluded from mutation:

```text
!src/services/**/*.test.ts
!src/services/**/*.spec.ts
```

The configuration uses:

```json
{
  "thresholds": {
    "high": 75,
    "low": 50,
    "break": 60
  }
}
```

The important enforcement value is the break threshold:

```text
60%
```

A mutation score below the configured break threshold causes the mutation run to fail.

Mutation reports are generated under:

```text
reports/
```

---

## k6 Load Tests

Load testing is maintained separately from the Jest suite:

```text
load-tests/
```

The k6 implementation is under:

```text
load-tests/k6/
```

with shared utilities under:

```text
load-tests/k6/lib/
```

and scenarios under:

```text
load-tests/k6/scenarios/
```

The load-test project has its own:

```text
load-tests/package.json
load-tests/tsconfig.json
load-tests/.env.example
load-tests/README.md
```

Use the scenario names documented in `load-tests/README.md` rather than inventing new commands.

Typical load-test categories include:

```text
auth-load
deliveries-load
socket-load
```

A generic k6 execution is:

```bash
k6 run load-tests/k6/scenarios/<scenario>.js
```

Before executing load tests:

1. Configure the environment using `load-tests/.env.example`.
2. Start the backend.
3. Ensure MongoDB is available.
4. Ensure required Redis/Stellar dependencies are available.
5. Use a dedicated test environment.
6. Do not execute high-volume tests against production.

---

## New Service Test Template

Create a test using the existing Jest/TypeScript conventions:

```typescript
import { describe, expect, it, jest, beforeEach } from '@jest/globals';

describe('ExampleService', () => {
  let service: ExampleService;

  beforeEach(() => {
    service = new ExampleService();
  });

  describe('methodName', () => {
    it('returns the expected result for valid input', async () => {
      const result = await service.methodName('value');

      expect(result).toEqual({
        success: true,
      });
    });

    it('handles missing or invalid input', async () => {
      await expect(service.methodName('')).rejects.toThrow();
    });
  });
});
```

For a database-backed service, mock only dependencies that are not part of the behavior being tested.

For integration behavior, use the project's existing MongoDB test setup instead of introducing a second database bootstrap mechanism.

---

## Recommended Test Workflow

For a normal service change:

```bash
pnpm test -- <specific-test-file>
```

Then:

```bash
pnpm test
```

Then:

```bash
pnpm test:coverage
```

For service-heavy changes:

```bash
pnpm test:mutation
```

Finally:

```bash
pnpm lint
pnpm build
```

---

## Test Checklist

Before opening a PR:

* [ ] New behavior has a focused test.
* [ ] Error paths are covered.
* [ ] Authentication/authorization behavior is covered where applicable.
* [ ] Database behavior uses the existing test infrastructure.
* [ ] Coverage thresholds pass.
* [ ] Mutation testing is considered for service-layer changes.
* [ ] Integration tests are added when multiple application layers interact.
* [ ] Load testing is used for performance-sensitive changes.
* [ ] `pnpm lint` passes.
* [ ] `pnpm build` passes.
