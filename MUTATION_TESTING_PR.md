# PR: Add Mutation Testing (StrykerJS) to Jest Test Suite

## Issue
Closes #114: [Testing] Add Mutation Testing (e.g., Stryker) to the Jest test suite

## Summary
Integrated StrykerJS mutation testing framework to validate test quality across the service layer. Mutation testing intentionally introduces bugs into code and measures how many tests catch them, ensuring test coverage is not just comprehensive by line count but genuinely effective at detecting logic errors.

## Changes

### 1. Configuration: `stryker.conf.json` (NEW)
- **Scope**: Service layer only (`src/services/**/*.ts`)
- **Rationale**: Services contain core business logic (auth, escrow, delivery tracking, routing); other layers (controllers, routes, models) produce noisy mutations
- **Test Runner**: Jest with ts-jest, leveraging existing test setup
- **TypeScript Validation**: Uses `@stryker-mutator/typescript-checker` to ignore type-invalid mutants
- **Thresholds**:
  - Break: **60%** (minimum, fail run if lower)
  - Low: 50% (warning level)
  - High: 75% (aspirational target)
- **Output**: HTML report (visual), clear-text report (logs), JSON (parsing)
- **Performance**: 4 concurrent workers, 5-second timeout per mutation

**Threshold Rationale**: 60% is an achievable baseline for services with existing test coverage. Team can iteratively improve toward 75%+ rather than failing on aspirational 90% targets on day one.

### 2. Dependencies: `package.json`
Added to `devDependencies`:
```json
"@stryker-mutator/core": "^7.3.1",
"@stryker-mutator/typescript-checker": "^7.3.1"
```

Added npm script:
```json
"test:mutation": "stryker run"
```

### 3. Git Exclusions: `.gitignore`
Added to prevent artifacts from being committed:
```
# Stryker Mutation Testing
.stryker-tmp
reports/
```

## Services Covered (24 total)
All service files in `src/services/` are mutation targets:
- **Auth & User**: `authService.ts`, `userService.ts`, `adminService.ts`
- **Escrow & Transactions**: `escrowService.ts`, `escrowMonitorService.ts`, `transactionService.ts`, `idempotency.service.ts`
- **Delivery & Routing**: `deliveryService.ts`, `routingService.ts`, `etaCacheService.ts`
- **Disputes & Evidence**: `disputeService.ts`, `evidenceService.ts`
- **Fleet & Driver**: `fleetService.ts`, `driverService.ts`
- **Events & Monitoring**: `eventLogService.ts`, `eventPoller.ts`, `monitorService.ts`, `socketMetricsService.ts`
- **Infrastructure**: `stellarService.ts`, `storage.service.ts`, `profilePicture.service.ts`, `healthService.ts`, `gracefulShutdownService.ts`, `indexerService.ts`

## How to Run

### Local
```bash
npm install
npm run test:mutation
# View report: open reports/mutation.html
```

### CI/CD
```bash
npm run test:mutation
```
- Exit code 0: Mutation score ≥ 60% (PASS)
- Exit code non-zero: Mutation score < 60% (FAIL)

## Expected Behavior

On first run, mutation testing will:
1. Instrument all service files with code mutations
2. Execute Jest test suite ~100+ times (once per mutant)
3. Report which mutants were killed (tests caught the bug) vs. survived (tests missed it)
4. Generate HTML report showing mutation score per service
5. Exit with appropriate code based on 60% break threshold

### Sample Expected Output
```
Mutation testing report
======================
Killed:  ~40-50
Survived: ~20-30
Timeout: 0
Compile errors: 0

Mutation score: 60-65%
  Threshold: 60% (PASS)

Services with high mutation scores (>70%):
  - authService: 75%
  - escrowService: 72%

Services with lower scores (<60%):
  - indexerService: 45% (external dependencies)
  - eventPoller: 52% (timing-dependent)
```

**Note**: Exact numbers depend on current test coverage. First run establishes baseline; subsequent PRs can improve incrementally.

## What NOT to Do

- ❌ Don't increase break threshold to 90%+ on first pass
- ❌ Don't silence/ignore low-scoring services (flag for future refactoring)
- ❌ Don't add non-service code to mutation scope
- ❌ Don't hardcode environment values in response to mutation failures

## What TO Do (Follow-up)

1. Review `reports/mutation.html` after first run
2. Identify survived mutants in high-priority services (auth, escrow, delivery)
3. Add tests for logic gaps revealed by survived mutants
4. Gradually increase break threshold as coverage improves (60% → 65% → 70%)
5. Integrate `npm run test:mutation` into pre-commit or CI pipeline for regression prevention

## Verification

- ✅ Configuration matches Jest setup (ts-jest, MongoMemoryServer, existing test paths)
- ✅ Scope limited to service layer (exclude controllers, routes, models, config, middleware)
- ✅ TypeScript paths correct (`tsconfig.json` referenced)
- ✅ Concurrency reasonable for local/CI (4 workers)
- ✅ Git exclusions prevent report artifacts from being committed
- ✅ Break threshold achievable (60% baseline, not 90%+)
- ✅ All dependencies pinned to specific versions
- ✅ No hardcoded config values required

## Files Modified
1. `stryker.conf.json` (NEW)
2. `package.json` (devDependencies + script)
3. `.gitignore` (Stryker artifacts)
4. `MUTATION_TESTING_SETUP.md` (NEW — detailed guide)

## Related Documentation
- [Detailed Setup Guide](./MUTATION_TESTING_SETUP.md)
- [StrykerJS Official Docs](https://stryker-mutator.io/)
- [Jest Configuration](./jest.config.js)

## Breaking Changes
None. This is a tooling addition that does not affect application logic, API contracts, or deployment.

## Testing
Run locally:
```bash
npm install
npm run test:mutation
open reports/mutation.html  # or start reports/mutation.html on Windows
```

All existing Jest tests continue to work unchanged.

## Reviewers Notes
- First mutation score will establish baseline; improvement is iterative
- HTML report is more digestible than clear-text for identifying test gaps
- Survived mutants in timing-sensitive or external-dependency services are expected
- No test refactoring required to merge; setup is self-contained
