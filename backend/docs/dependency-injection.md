# Dependency Injection Container (Awilix)

> **Issue:** #272 — DI container and dependency wiring guide
>
> This guide teaches contributors how to register services, models and controllers in the
> Awilix container, how tokens are named, how the PROXY injection mode and singleton lifecycle
> work, how to break circular dependencies with the established dynamic-import pattern, and how
> to verify that a registration is valid before opening a PR.

## Table of contents

1. [Where the container lives](#1-where-the-container-lives)
2. [Container lifecycle & PROXY injection](#2-container-lifecycle--proxy-injection)
3. [Token naming rules & `.service.ts` conventions](#3-token-naming-rules--service-conventions)
4. [Worked example: add a new service and controller](#4-worked-example-add-a-new-service-and-controller)
5. [Breaking circular dependencies (dlqService pattern)](#5-breaking-circular-dependencies-dlqservice-pattern)
6. [Verifying registration validity (the `di.container` test)](#6-verifying-registration-validity-the-dicontainer-test)
7. [Warning: duplicate tokens](#7-warning-duplicate-tokens)
8. [PR checklist](#8-pr-checklist)

---

## 1. Where the container lives

| File | Purpose |
|---|---|
| `src/di/tokens.ts` | Declares every injection token, grouped by category (Services, Models, Config, Controllers). |
| `src/di/container.ts` | Builds the container (`createDIContainer`), registers every dependency, and exposes the process-wide instance (`getContainer`, `resetContainer`). |
| `src/di/index.ts` | Barrel that re-exports `getContainer`, `createDIContainer`, `resetContainer` and `TOKENS`. |

The container is created **once at application startup**: `src/app.ts` calls `getContainer()` at
module load, before any request is served.

```ts
import { getContainer } from './di';
// Initialize DI container at application startup
getContainer();
```

Architecture enforced by the wiring (non-negotiable, see `backend/CONTRIBUTING.md`):

```
Controller  →  Service  →  Model (Mongoose)
```

The container registers four categories of dependency:

- **Config & infrastructure** — `logger`, `env`, `redisClient`
- **Models** — Mongoose schemas (`deliveryModel`, `escrowModel`, …)
- **Services** — business logic (`deliveryService`, `escrowService`, …)
- **Controllers** — request handlers (`deliveryController`, `escrowController`, …)

Plus the external SDK clients behind provider interfaces (issue #222): `routingProvider`,
`sorobanRpcClient`, `imagesStorage`.

---

## 2. Container lifecycle & PROXY injection

```ts
const container = createContainer({
  injectionMode: InjectionMode.PROXY,
});
```

### Injection mode: `PROXY`

Awilix supports several injection modes. This project uses **`InjectionMode.PROXY`**:

- Dependencies are injected through a JavaScript `Proxy` that resolves each named dependency
  **at property-access time**, not at construction time.
- Resolution order therefore never matters: two services that reference each other's token can
  both be resolved as long as the access happens after registration completes.
- Consumers declare what they need by parameter name, e.g.
  `constructor(private readonly deliveryService = deliveryService)` — the proxy intercepts
  `deliveryService` and returns the registered value.

Because every registration in this codebase is an already-constructed singleton registered with
`asValue(...)` (see below), PROXY mode mostly matters for future class-based registrations
(`asClass`) and for keeping resolution order-independent.

### Singleton lifecycle

Everything is registered as a **singleton**:

| Category | Registration | Lifetime |
|---|---|---|
| Config, logger, Redis | `asValue(logger)` | one value for the process |
| Models (Mongoose schemas) | `asValue(Delivery)` | one model per process (Mongoose already dedupes by name) |
| Services | `asValue(deliveryService)` | one instance — the module-level singleton |
| Controllers | `asValue(deliveryController)` | one instance — the module-level singleton |

The container instance itself follows the same pattern in `src/di/container.ts`:

```ts
let container: AwilixContainer | null = null;

export function getContainer(): AwilixContainer {
  if (!container) container = createDIContainer(); // created lazily, once
  return container;
}

export function resetContainer(): void {
  container = null; // tests only — next getContainer() builds a fresh one
}
```

- **`getContainer()`** — application startup; returns the same container for the process lifetime.
- **`createDIContainer()`** — builds a *new*, fully-populated container. Tests use this to get an
  isolated container they can override dependencies on.
- **`resetContainer()`** — drops the cached instance so the next call re-creates it (test isolation).

> **Note on identity:** because services are registered as *values* (module singletons), two
> containers built by `createDIContainer()` return the **same** service objects. The container
> owns the *registry*, not the service instances. A test that needs a different service instance
> must register a mock with `asValue(mock)` — see §4.

---

## 3. Token naming rules & `.service.ts` conventions

**Rule: exactly one canonical camelCase token per dependency.** Legacy snake_case aliases
(`delivery_service`, `escrow_service`, …) were removed and must never come back (see §7).

### Tokens

Tokens are declared in `src/di/tokens.ts` and grouped by category. The token string is the
camelCase identifier itself:

```ts
export const TOKENS = {
  // Services
  deliveryService: 'deliveryService',
  escrowService: 'escrowService',
  // Models (Mongoose schemas)
  deliveryModel: 'deliveryModel',
  escrowModel: 'escrowModel',
  // Controllers
  deliveryController: 'deliveryController',
  escrowController: 'escrowController',
  // Config & infrastructure
  logger: 'logger',
  env: 'env',
  redisClient: 'redisClient',
} as const;
```

### File-naming conventions → tokens

| Service file | Export shape | Token |
|---|---|---|
| `src/services/escrow.service.ts` | `export const escrowService = new EscrowService()` (+ `export default`) | `escrowService` |
| `src/services/delivery.service.ts` | `export const deliveryService = new DeliveryService()` | `deliveryService` |
| `src/services/authService.ts` (legacy camelCase filename) | `export default authService` | `authService` |
| `src/services/fleetService.ts` | `export * as fleetService`-style namespace or singleton | `fleetService` |
| `src/controllers/escrow.controller.ts` | `export const escrowController` | `escrowController` |
| `src/models/Escrow.ts` | `export default mongoose.model(...)` | `escrowModel` |

Derived rules:

1. **Strip the `.service` suffix and camelCase the rest** — `idempotency.service.ts` →
   `idempotencyService`; `profilePicture.service.ts` → `profilePictureService`.
2. **Models add a `Model` suffix** — `Escrow.ts` → `escrowModel`, never `escrow`.
3. **Controllers use `Controller`** — `escrow.controller.ts` → `escrowController`.
4. **One file, one token, one registration.** If two names would describe the same object
   (e.g. `escrowService` and `escrow_service`), that is a bug — §7.
5. New services should use the **`kebab.service.ts`** file naming
   (`escrow.service.ts` style); the camelCase filenames (`authService.ts`) are legacy but still
   valid for existing modules.

---

## 4. Worked example: add a new service and controller

The following walks through adding a hypothetical `dispatchService` + `dispatchController` end
to end. Copy this flow for any new dependency.

### Step 1 — Create the service (`src/services/dispatch.service.ts`)

Follow the layered architecture: the service talks to models/repositories only, never to Express.

```ts
import httpStatus from 'http-status-codes';
import { AppError } from '../utils/AppError';
import Delivery from '../models/Delivery';

export class DispatchService {
  async listPending(): Promise<Delivery[]> {
    return Delivery.find({ status: 'pending' }).lean();
  }
}

export const dispatchService = new DispatchService();
export default dispatchService;
```

### Step 2 — Create the controller (`src/controllers/dispatch.controller.ts`)

Controllers depend on **service singletons**, keep typings strong, and never contain business
logic:

```ts
import { Request, Response, NextFunction } from 'express';
import httpStatus from 'http-status-codes';
import { dispatchService } from '../services/dispatch.service';
import { sendSuccess } from '../utils/responseWrapper';

export class DispatchController {
  async listPending(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const pending = await dispatchService.listPending();
      sendSuccess(res, pending, 'Pending deliveries retrieved', httpStatus.OK);
    } catch (error) {
      next(error);
    }
  }
}

export const dispatchController = new DispatchController();
export default dispatchController;
```

### Step 3 — Declare the tokens (`src/di/tokens.ts`)

```ts
export const TOKENS = {
  // Services
  dispatchService: 'dispatchService',   // ← new
  // …
  // Controllers
  dispatchController: 'dispatchController', // ← new
} as const;
```

Never register a token that is not declared here — the constant map is the single source of
truth and is exercised by the regression test in §7.

### Step 4 — Register both in the container (`src/di/container.ts`)

```ts
// ─── Services ──────────────────────────────────────────────────────────
import { dispatchService } from '../services/dispatch.service';

// ─── Controllers ───────────────────────────────────────────────────────
import { dispatchController } from '../controllers/dispatch.controller';

// inside createDIContainer():
container.register({
  [TOKENS.dispatchService]: asValue(dispatchService),
});

container.register({
  [TOKENS.dispatchController]: asValue(dispatchController),
});
```

Two registrations, one token each, both `asValue` (singleton) — matching the lifetime table in
§2.

### Step 5 — Resolve it

At application start-up (or in a job/CLI script):

```ts
import { getContainer, TOKENS } from './di';

const container = getContainer();
const service = container.resolve(TOKENS.dispatchService);
await service.listPending();
```

In a route you normally import the controller singleton directly (that is the current
convention — `router.get('/', dispatchController.listPending)`); the container registration
exists so the dependency graph is complete, inspectable and overridable in tests.

### Step 6 — Override it in a test

```ts
import { createDIContainer, TOKENS } from '../src/di';
import { asValue } from 'awilix';

const container = createDIContainer();     // fresh registry, isolated from the app
container.register({
  [TOKENS.dispatchService]: asValue({
    listPending: jest.fn().mockResolvedValue([]),
  }),
});

const service = container.resolve(TOKENS.dispatchService);
```

Because registrations are plain values, overriding is a one-liner — no module mocking required.

---

## 5. Breaking circular dependencies (dlqService pattern)

### The problem

`stellarService` needs to write failed transactions to the dead-letter queue (`dlqService`),
while `dlqService.retryEntry` needs to re-submit through `stellarService`. A top-level
`import` in both directions makes the module graph circular: whichever module loads first gets
a half-initialised partner (`undefined` at import time), and TypeScript/Node resolve it
differently depending on entry order.

### The established fix: dynamic import at the call site

The codebase breaks the cycle with a **lazy `await import()` inside the function body**, never
at module top level.

`src/services/stellarService.ts` (producer side):

```ts
// Store in Dead Letter Queue (DLQ)
const { dlqService } = await import('./dlqService');
await dlqService.addEntry(input, errorMessage).catch((dlqErr) => {
  logger.error(`[StellarService] Failed to save to DLQ: ${extractMessage(dlqErr)}`);
});
```

`src/services/dlqService.ts` (consumer side):

```ts
// Dynamic import to break circular dependency with stellarService
const { stellarService } = await import('./stellarService');
const result = await stellarService.submitEscrowLock(entry.payload);
```

Why this works: the second module is only loaded **after** the first has finished evaluating,
so both modules see fully-initialised exports.

### Rules for using this pattern

1. Put the dynamic import **inside the method that needs it**, as close to the use site as
   possible.
2. Only do this to break a *genuine* cycle. If one side merely needs a helper, extract the
   helper into a third, dependency-free module instead.
3. Keep the `await import(...)` inside a `try/catch` (or a `.catch(...)`) so a resolution
   failure surfaces as a logged, handleable error rather than an unhandled rejection.
4. Prefer constructor/parameter injection (or plain module imports) whenever the dependency
   graph is acyclic — lazy imports are the escape hatch, not the default.

---

## 6. Verifying registration validity (the `di.container` test)

`tests/di.container.test.ts` is the executable specification of the container. It:

1. **Initialises the container** — `createDIContainer()` builds without throwing, with PROXY
   injection mode.
2. **Resolves config & infrastructure** — `logger`, `env`, `redisClient`.
3. **Resolves every model** — iterates the full model token list and asserts each has a
   `collection`.
4. **Resolves every service and controller** — iterates the full token lists; a token added to
   `tokens.ts` but never registered (or vice versa) fails here.
5. **Asserts singleton identity** — resolving the same token twice returns `===` the same
   object, for services *and* controllers.
6. **Proves overridability** — registers `asValue(mock)` for `logger`/`authService` on a fresh
   container and asserts the mock is what gets resolved.
7. **Guards against duplicate/legacy tokens** — see §7.

### Running it

```bash
# single suite (fast)
npx jest tests/di.container.test.ts

# or through the package script
pnpm test -- tests/di.container.test.ts
```

### Manual sanity check of the registry

To dump every registered token:

```bash
npx ts-node -e "
import { createDIContainer } from './src/di/container';
const c = createDIContainer() as unknown as { registrations: Record<string, unknown> };
console.log(Object.keys(c.registrations).sort().join('\n'));
"
```

Anything listed here that is not in `src/di/tokens.ts` (or vice versa) is a wiring bug.

---

## 7. Warning: duplicate tokens

### What went wrong before

The container previously registered **two names for the same object**, e.g. the canonical
`deliveryService` *and* a legacy snake_case alias `delivery_service` (likewise
`escrow_service`, `delivery_controller`, `escrow_controller`, `indexer_controller`,
`stellar_controller`). This caused real problems:

- **Ambiguous resolution** — a consumer imported `delivery_service` while a teammate used
  `deliveryService`; if only one alias was registered, the other consumer threw an Awilix
  `RESOLUTION_FAILED` error at runtime.
- **Divergent state** — where an alias was wired to a *different* instance (e.g. `new
  DeliveryService()` instead of the shared singleton), code paths silently operated on two
  separate objects with separate state.
- **Stale bindings** — renaming the real registration left the alias pointing at an outdated
  binding, which only failed on the code path that happened to use it.

Aliases have since been removed; `src/di/tokens.ts` documents the policy:

> *Token policy: exactly one canonical camelCase token per registration. Legacy snake_case
> aliases (e.g. `delivery_service`) were removed so the container can never resolve a duplicate
> or ambiguous binding for the same dependency.*

### How to check for duplicates

1. **Run the regression guard** (part of the `di.container` suite):

   ```bash
   npx jest tests/di.container.test.ts -t "registers exactly one canonical token per dependency"
   ```

   It reads the container's internal `registrations` map and asserts the legacy aliases
   (`delivery_service`, `escrow_service`, `delivery_controller`, `escrow_controller`,
   `indexer_controller`, `stellar_controller`) are **not** present.

2. **Grep for snake_case registrations:**

   ```bash
   grep -nE "'[a-z]+_[a-z_]+'" src/di/tokens.ts src/di/container.ts
   ```

   The only snake_case strings that may appear are *comments* about the removed aliases.

3. **Diff the registry against the token map** with the dump command in §6 — a name present in
   one but not the other means a duplicate or a missing registration.

### Rules

- **Never** register an alias "for convenience". Update the import at the call site instead.
- **Never** register the same token twice — a later `register` silently replaces the earlier
  one, which is exactly how stale bindings appeared before.
- Adding a service means: one token in `tokens.ts`, one `register` call, one import.

---

## 8. PR checklist

When your change touches the container, confirm all of the following:

- [ ] Token declared exactly once in `src/di/tokens.ts` (canonical camelCase, no aliases).
- [ ] Registered exactly once in `src/di/container.ts` with `asValue(...)` (singleton).
- [ ] File name follows the `.service.ts` / `.controller.ts` conventions (§3).
- [ ] No new circular import — the dynamic-import pattern is used only if genuinely required (§5).
- [ ] `npx jest tests/di.container.test.ts` passes.
- [ ] `npx tsc --noEmit` passes.
- [ ] No snake_case token has been reintroduced (§7).
