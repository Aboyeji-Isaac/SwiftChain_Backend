# Mutation Testing Implementation (Issue #114)

## Overview

This document describes the mutation testing setup for SwiftChain Backend using [StrykerJS](https://stryker-mutator.io/), a mutation testing framework that verifies test quality by intentionally introducing bugs (mutants) into code and checking if tests catch them.

## What is Mutation Testing?

Mutation testing validates that your tests actually catch bugs. It works by:
1. Creating mutants — intentionally broken versions of your code
2. Running your test suite against each mutant
3. Measuring how many mutants are "killed" (caught by tests) vs. "survived" (tests still pass despite the bug)
4. Calculating a mutation score (% of mutants killed)

A high mutation score indicates strong test coverage with tests that catch real logic errors, not just lines of code.

## Configuration

### File: `stryker.conf.json`

**Mutation Scope:**
- **Target**: `src/services/**/*.ts` — Only the service layer (core business logic)
- **Rationale**: Services contain the pure business logic where mutations create meaningful results. Controllers, routes, models, config, middleware, validators, and utils are excluded because:
  - Controllers/Routes: Low-value mutations (often just orchestration)
  - Models/Schemas: Database schema mutations are noisy
  - Config: Environment-dependent mutations create brittle tests
  - Middleware: Infrastructure code, not business logic
  - Utils: Generic utilities, not domain-specific logic

**Services Covered (24 total):**
```
src/services/
├── adminService.ts
├── authService.ts
├── delivery.service.ts / deliveryService.ts
├── disputeService.ts
├── driverService.ts
├── escrow.service.ts / escrowService.ts / escrowMonitorService.ts
├── etaCacheService.ts
├── eventLogService.ts
├── eventPoller.ts
├── evidenceService.ts
├── fleetService.ts
├── gracefulShutdownService.ts
├── healthService.ts
├── idempotency.service.ts
├── indexerService.ts
├── monitorService.ts
├── profilePicture.service.ts
├── routingService.ts
├── socketMetricsService.ts
├── stellarService.ts
├── storage.service.ts
├── transactionService.ts
└── userService.ts
```

**Test Runner Integration:**
- Jest with ts-jest transformer
- Existing `jest.config.js` reused (no parallel setup)
- TypeScript checker plugin enables/disables type-invalid mutants
- Test timeout: 5000ms per mutation (1.5x factor for variance)

**Thresholds (3-tier system):**
- **Break: 60%** — Minimum acceptable. Run exits with error if mutation score drops below this. Initial bar is intentionally achievable rather than aspirational (e.g., not 90%+) to establish baseline coverage and allow iterative improvement.
- **Low: 50%** — Warning threshold (logged in reports)
- **High: 75%** — Target quality level for future refactoring

**Rationale for 60% break threshold:**
- Services contain complex business logic (auth, escrow, delivery tracking, routing) with existing test coverage
- Full coverage unlikely on first run due to edge cases and integration points
- 60% represents a realistic starting point; team can refactor tests and increase gradually
- Prevents regression while allowing incremental quality improvements

**Performance Settings:**
- Concurrency: 4 workers (reasonable for CI/local; adjust if needed)
- Reporters: HTML (visual inspection), clear-text (logs), JSON (parsing)
- Output directory: `reports/` (excluded from git)

### File: `package.json` Changes

**New devDependencies:**
```json
"@stryker-mutator/core": "^7.3.1",
"@stryker-mutator/typescript-checker": "^7.3.1"
```

**New npm script:**
```json
"test:mutation": "stryker run"
```

### File: `.gitignore` Changes

Added to prevent mutation test artifacts from being committed:
```
# Stryker Mutation Testing
.stryker-tmp
reports/
```

## How to Run

### Local Development

```bash
# First time: install dependencies (or update if added)
npm install

# Run mutation tests
npm run test:mutation

# View HTML report
# Open reports/mutation.html in browser
```

### In CI/CD

```bash
npm run test:mutation
```

The exit code indicates pass/fail:
- **0**: Mutation score ≥ 60% (break threshold)
- **Non-zero**: Mutation score < 60% (indicates untested edge cases)

### Sample Output (Clear-Text Report)

```
Mutation testing report
======================
Killed:  42
Survived: 28
Timeout: 0
Compile errors: 0

Mutation score: 60%
  Threshold: 60% (PASS)
```

## Understanding Results

### Mutation Score Interpretation

- **Score ≥ 75% (High)**: Excellent — tests are comprehensive and catch most logic errors
- **Score 60–74% (Target Range)**: Good — most common scenarios tested, some edge cases remain
- **Score < 60% (Break)**: Failing — untested logic paths; run stops and indicates areas for test improvement

### Reading the HTML Report

`reports/mutation.html` shows:
1. **Per-file breakdown** — Which services have strong vs. weak mutation scores
2. **Mutation details** — Each mutant with context showing what was mutated and whether tests caught it
3. **Survived mutants** — Code that was changed but tests still passed (potential gaps)
4. **Killed mutants** — Code that was caught by tests

### Common Survived Mutants (And What They Mean)

| Mutation Type | Meaning | Action |
|---|---|---|
| `>` → `>=` or `===` → `==` | Boundary condition untested | Add boundary tests |
| Removed `if` block | Error handling untested | Add error case tests |
| Changed string literal | Input validation untested | Add validation tests |
| Removed loop iteration | Edge case untested | Add tests for empty/single-item collections |

## Architecture Alignment

This implementation respects repo-wide architecture constraints:

✅ **Service-Model Separation**: Only services mutated; models remain stable
✅ **.env-backed Config**: Tests rely on existing Jest setup (MongoMemoryServer) — no hardcoded values
✅ **Versioned API Routes**: All exercised logic sits behind `/api/v1/` versioning
✅ **TypeScript Type Safety**: Invalid mutants filtered by TypeScript checker plugin
✅ **Production-ready Config**: Correct paths, sensible concurrency, proper exclusions

## Next Steps

1. **First Run**: Execute `npm run test:mutation` and review `reports/mutation.html`
2. **Analyze Gaps**: Identify survived mutants indicating untested logic
3. **Iterative Improvement**: 
   - Prioritize tests for high-impact services (escrow, auth, delivery)
   - Aim to increase score incrementally (60% → 65% → 70% → 75%+)
   - Document complex edge cases in test comments
4. **CI Integration**: Add `npm run test:mutation` to pre-commit hooks or CI pipeline to prevent regression
5. **Team Review**: Schedule walkthrough of HTML report to align on test gaps

## Files Changed

- ✅ `stryker.conf.json` — Created
- ✅ `package.json` — Updated (dependencies + script)
- ✅ `.gitignore` — Updated (Stryker artifacts)

## References

- [StrykerJS Documentation](https://stryker-mutator.io/)
- [Jest Configuration](./jest.config.js)
- [TypeScript Configuration](./tsconfig.json)
- [Service Layer Architecture](./src/services/)
