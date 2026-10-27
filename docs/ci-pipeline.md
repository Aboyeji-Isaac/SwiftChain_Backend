# CI/CD Pipeline

Use this checklist before opening a pull request:

- [ ] Node.js 22.x and MongoDB 6.0 are available locally.
- [ ] Dependencies are installed with `pnpm install` and any `pnpm-lock.yaml` change is committed.
- [ ] `pnpm run lint` passes.
- [ ] `pnpm exec tsc --noEmit` passes (CI also runs `pnpm run build`).
- [ ] `pnpm test:coverage` passes with the required coverage thresholds.

## What CI runs

The workflow in `.github/workflows/ci.yml` runs on pushes and pull requests targeting `main` or
`develop`. Its environment matrix uses Node.js 22.x and MongoDB 6.0. The job installs pnpm 9,
starts MongoDB, installs dependencies, then runs these stages:

```bash
pnpm install
pnpm run lint
pnpm run build
pnpm test:coverage
```

`pnpm run build` invokes `tsc` and is the CI compilation gate. The equivalent no-emit check is
useful during development because it validates TypeScript without writing `dist/`:

```bash
pnpm exec tsc --noEmit
```

Tests use MongoDB at `mongodb://localhost:27017/swiftchain_test` in CI. For a local run, start a
MongoDB 6.0-compatible server and provide a JWT secret accepted by the environment schema:

```bash
CI=true MONGO_URI=mongodb://localhost:27017/swiftchain_test \
  JWT_SECRET=test-secret-key-16chars pnpm test:coverage
```

## Coverage and pull-request comments

Jest writes text, JSON summary, and `coverage/lcov.info` output to `coverage/`. The configured
minimums are:

| Scope           | Branches | Functions | Lines | Statements |
| --------------- | -------: | --------: | ----: | ---------: |
| Global          |      60% |       60% |   60% |        60% |
| `src/services/` |      80% |       80% |   80% |        80% |
| `src/models/`   |      70% |       70% |   70% |        70% |
| `src/routes/`   |      60% |       60% |   60% |        60% |

CI uploads the complete `coverage/` directory as an artifact. On pull requests, the
`romeovs/lcov-reporter-action` reads `coverage/lcov.info` and posts a coverage comment. The
comment step is allowed to continue on error, but Jest fails the job when a configured threshold
is not met.

## Lockfile and package-manager requirement

CI uses pnpm 9 and the repository's `pnpm-lock.yaml`. Run project commands with pnpm rather than
silently generating an npm or Yarn lockfile. If dependency resolution changes, review and commit
the resulting `pnpm-lock.yaml` in the same pull request.
