# Contributing to SwiftChain Backend

Thank you for contributing to **SwiftChain_Backend**. This guide covers everything you need to
set up a local development environment, follow project conventions, and submit a pull request.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Local Setup](#2-local-setup)
3. [Development Commands](#3-development-commands)
4. [Issue Workflow](#4-issue-workflow)
5. [Branch Naming](#5-branch-naming)
6. [Architecture](#6-architecture)
7. [Code Conventions](#7-code-conventions)
8. [PR Workflow and Checklist](#8-pr-workflow-and-checklist)
9. [Troubleshooting](#9-troubleshooting)
10. [Proof of Work](#10-proof-of-work)

---

## 1. Prerequisites

The following tools and services are required to work on the SwiftChain Backend.

| Prerequisite | Notes |
|---|---|
| **Node.js 22+** | Required runtime. |
| **pnpm** | The project's package manager. |
| **MongoDB** | Required for any work that touches the database layer or integration tests. |
| **Redis** | Required for caching, distributed locking, and location deduplication features. |
| **Stellar testnet / futurenet access** | Required only when working on escrow, Soroban, or Stellar integration features. |
| **FCM service account** | Required only when working on push notification features. |

> **Note:** MongoDB, Redis, Stellar access, and FCM credentials are prerequisites for the
> specific areas of the codebase that use them. They are not required when working on
> unrelated features (e.g., pure business logic, routing, or documentation tasks).
> Do not add credentials or secrets to source control.

---

## 2. Local Setup

### Clone the repository

```bash
git clone https://github.com/SwiftChainn/SwiftChain_Backend.git
cd SwiftChain_Backend
```

### Install dependencies

```bash
pnpm install
```

### Configure environment variables

Copy the example environment file and populate it with values appropriate for your environment:

```bash
cp .env.example .env
```

Open `.env` and fill in the values you need. Key variables include:

| Variable | Purpose |
|---|---|
| `MONGODB_URI` | MongoDB connection string |
| `JWT_SECRET` | Secret key for signing JWTs |
| `REDIS_URL` | Redis connection URL |
| `SOROBAN_RPC_URL` | Soroban RPC endpoint (testnet/mainnet) |
| `STELLAR_NETWORK_PASSPHRASE` | Must match the chosen Stellar network |
| `STELLAR_NETWORK` | Friendly alias — `testnet`, `futurenet`, or `mainnet` |
| `ESCROW_CONTRACT_ID` | Deployed Soroban contract address |

See `.env.example` at the repository root for the full list of supported variables and their
descriptions. Do not commit real credentials to source control.

### Run the development server

```bash
pnpm run dev
```

The server starts with `nodemon` and reloads automatically on file changes.

### Run with Docker (optional)

If you prefer a containerised environment:

```bash
docker-compose up --build
```

---

## 3. Development Commands

Run these commands from the repository root.

### `pnpm run lint`

Runs ESLint across all TypeScript source files. Fix lint errors before opening a PR.

```bash
pnpm run lint
```

### `pnpm run build`

Compiles the TypeScript source to JavaScript using `tsc`. Confirms the project type-checks
cleanly with no compilation errors.

```bash
pnpm run build
```

### `pnpm test`

Runs the full Jest test suite (unit and integration tests).

```bash
pnpm test
```

### `pnpm test:coverage`

Runs the test suite and generates a coverage report. Check coverage before opening a PR,
particularly when adding new business logic or services.

```bash
pnpm test:coverage
```

---

## 4. Issue Workflow

Follow this workflow for every contribution:

1. **Select an existing issue.** Pick an open issue that is unassigned or has been offered to
   the community. Do not start work on an issue that is already assigned to someone else.

2. **Read the requirements and acceptance criteria.** Understand exactly what is expected before
   writing any code. Pay attention to scope boundaries noted in the issue.

3. **Request or confirm assignment.** If the issue requires assignment before work begins, leave
   a comment requesting it and wait for a maintainer to assign you before opening a branch.

4. **Create a branch.** Branch from the latest `main` (or the base branch specified in the issue)
   using the naming conventions described in [Section 5](#5-branch-naming).

5. **Implement only the requested scope.** Do not bundle unrelated changes, refactors, or new
   features into the same PR. One issue → one PR.

6. **Run the appropriate checks.** Before opening a PR, run lint, build, tests, and coverage as
   described in [Section 3](#3-development-commands).

7. **Review the final diff.** Read through `git diff` before pushing. Verify there are no
   unintended changes, debug artifacts, or secrets.

8. **Open a PR.** Use the repository's PR template (`.github/pull_request_template.md`) and
   fill in every section.

---

## 5. Branch Naming

Use the following prefixes when naming branches. Keep the description short and lowercase,
using hyphens as separators.

| Prefix | Use for |
|---|---|
| `feat/` | New features |
| `fix/` | Bug fixes |
| `refactor/` | Code restructuring without behaviour change |
| `docs/` | Documentation changes |
| `test/` | Adding or improving tests |

**Examples:**

```text
feat/driver-assignment-algorithm
fix/escrow-release-timeout
refactor/delivery-service-extract-repository
docs/contributing-guide
test/auth-service-unit-tests
```

---

## 6. Architecture

The backend follows a strict four-layer architecture. Respect the boundaries between layers in
every change.

```
Controller → Service → Repository → Model
```

### Layer responsibilities

**Controller** (`src/controllers/`)
- Handles HTTP requests and responses.
- Validates request boundaries (authentication, authorisation, input shape).
- Delegates all business logic to the service layer.
- Must not contain business logic.

**Service** (`src/services/`)
- Contains all business logic and orchestration.
- Coordinates between repositories, external services (Stellar, Redis, etc.), and events.
- Does not interact with Mongoose models directly — all data access goes through the repository.

**Repository** (`src/repositories/`)
- Encapsulates all database/data-access operations.
- Provides a typed, queryable interface over Mongoose models.
- The only layer that should construct Mongoose queries or call model methods directly.

**Model** (`src/models/`)
- Defines Mongoose schemas and TypeScript document interfaces.
- Responsible for persistence structure, indexes, and schema-level hooks.
- Does not contain business logic.

### Key rules

- Controllers delegate; they do not decide.
- Services own business logic; repositories own data access.
- No layer should bypass the one below it (e.g., a controller must not query the database
  directly through a model).
- Keep each layer's responsibilities clear and narrow.

---

## 7. Code Conventions

### TypeScript

- **Strong typing is required.** Every function parameter, return type, and exported interface
  must be explicitly typed.
- **No `any`.** Use `unknown` with type guards, specific types, or generics instead. PRs that
  introduce `any` will be rejected.
- **Zod for input validation.** Validate all external input (request bodies, query parameters,
  headers) at the API boundary using Zod validators in `src/validators/`.

### Project conventions

- Follow the existing code style. The project uses ESLint (`eslint`) and Prettier (`.prettierrc`)
  for consistency. Run `pnpm run lint` and address all errors before committing.
- Match the naming conventions, file organisation, and import style you see in the existing
  `src/` directory.
- Maintain separation between layers as described in [Section 6](#6-architecture).

### API versioning

All new API endpoints must be versioned under `/api/v1/`:

```text
/api/v1/deliveries
/api/v1/escrow/...
/api/v1/disputes/...
```

Do not add unversioned routes. Do not increment the version for additions to existing
functionality unless there is a breaking change.

---

## 8. PR Workflow and Checklist

The repository provides a PR template at `.github/pull_request_template.md`. Fill in every
section when opening a PR.

### Before submitting

- [ ] The branch was created from a valid issue that is assigned to you (where required).
- [ ] The branch name follows the conventions in [Section 5](#5-branch-naming).
- [ ] The PR scope is focused — it addresses one issue and does not bundle unrelated changes.
- [ ] All TypeScript is strongly typed. No `any` is introduced.
- [ ] All external input is validated at the API boundary.
- [ ] New or updated endpoints are under `/api/v1/`.
- [ ] `pnpm run lint` passes with no errors.
- [ ] `pnpm run build` compiles without errors.
- [ ] `pnpm test` passes.
- [ ] `pnpm test:coverage` was checked where new logic was added.
- [ ] `git diff` was reviewed — no unintended changes, no debug code, no secrets.
- [ ] The PR description includes a clear summary of what was done and why.
- [ ] The PR references the issue using `Closes #issue_id` (see below).
- [ ] Proof of work is attached where required (see [Section 10](#10-proof-of-work)).

### Closing an issue

Every PR that resolves an issue must include the following in the PR description body, replacing
`issue_id` with the actual issue number:

```text
Closes #issue_id
```

This automatically closes the issue when the PR is merged.

---

## 9. Troubleshooting

If you encounter implementation questions or unexpected behaviour, consult the root-level
implementation summary documents in the repository. These documents record design decisions,
architecture choices, and verification details for specific subsystems:

| Document | Covers |
|---|---|
| `IMPLEMENTATION_REPORT.md` | Dependency injection (Awilix) container setup and architecture |
| `DI_IMPLEMENTATION_SUMMARY.md` | DI container design rationale, token registration, and testing |
| `DI_VERIFICATION_CHECKLIST.md` | Verification checklist for the DI refactor |
| `REDIS_REDLOCK_IMPLEMENTATION.md` | Distributed locking with Redlock |
| `ESCROW_E2E_TESTS_SUMMARY.md` | End-to-end escrow test coverage |
| `ESCROW_E2E_VERIFICATION.md` | Escrow integration verification |
| `MUTATION_TESTING_SETUP.md` | Stryker mutation testing configuration |
| `MUTATION_TESTING_COMPLETION_SUMMARY.md` | Mutation testing results |
| `SOCKET_LOCATION_TESTS_SUMMARY.md` | Socket.io location handler tests |
| `SOCKET_DEDUPLICATION_FIX.md` | Socket location deduplication fix |
| `DELIVERY_ETA_TESTS_PR.md` | Delivery ETA endpoint and test details |
| `REFRESH_TOKENS_IMPLEMENTATION_PLAN.md` | Refresh token design |
| `REFRESH_TOKENS_PLANNING_VERIFICATION.md` | Refresh token verification |
| `COVERAGE_ENFORCEMENT_PR.md` | Test coverage enforcement setup |
| `PROFILE_PICTURE_UPLOAD.md` | Profile picture upload service |
| `HAVERSINE_ANTI_MERIDIAN_FIX.md` | Haversine anti-meridian coordinate fix |
| `JWT_HTTPONLY_ANALYSIS.md` | JWT storage and HttpOnly cookie analysis |
| `ISSUE_39_IMPLEMENTATION_SUMMARY.md` | Issue #39 implementation notes |
| `ISSUE_124_ANALYSIS_VERIFICATION.md` | Issue #124 analysis |
| `ISSUE_126_2FA_VERIFICATION_REPORT.md` | 2FA implementation report |
| `ISSUE_126_VERIFICATION_SUMMARY.md` | 2FA verification summary |
| `2FA_IMPLEMENTATION_PLAN.md` | 2FA design plan |
| `DEPLOYMENT_SUMMARY.md` | Deployment notes |
| `SOCKET_IO_LOAD_TEST_PR.md` | Socket.io load test PR |

Start with the document most relevant to the area you are working on. If your question is not
answered there, open an issue or ask in the relevant PR thread.

---

## 10. Proof of Work

The repository expects contributors to demonstrate that their implementation works as described.
Attach proof of work in the PR description when required by the issue.

Accepted forms of proof include:

- **API response evidence** — a screenshot or copy of a successful API response from Postman,
  a browser, or a `curl` command, showing the expected response body and HTTP status.
- **Test output** — terminal output of `pnpm test` or `pnpm test:coverage` showing all relevant
  tests passing, including any new tests added as part of the contribution.

Attach proof directly in the PR description under the **Proof of Work** section of the PR
template. Do not fabricate screenshots, responses, or test output.
