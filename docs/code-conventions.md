# Backend Code Conventions

This document prevents parallel implementations from drifting apart. New code must follow these
rules; do not create a second file solely because an older naming variant already exists.

## Layering

Keep request flow in the following direction:

```text
route -> controller -> service -> repository -> Mongoose model
```

Controllers translate HTTP input and output. Services own business rules. Repositories own
database access. Models define persistence contracts. Background jobs may call services, but must
not bypass the service/repository boundaries for new behavior.

## File names

- Services use `*.service.ts` (`delivery.service.ts`, `escrow.service.ts`).
- Controllers use `*.controller.ts` (`delivery.controller.ts`, `escrow.controller.ts`).
- Repositories use `*Repository.ts` for the existing repository convention.
- Models use PascalCase names (`Delivery.ts`, `Escrow.ts`).
- Middleware files use a descriptive camelCase name under `src/middleware/` or
  `src/middlewares/`, matching the directory convention already used by the feature.
- Socket transport entrypoints are handlers under `src/sockets/`; the live server wiring belongs
  in `connectionHandler.ts`.

## Exports and dependency injection

Prefer named exports for services, controllers, repositories, and model types. A default export is
acceptable only where the surrounding module already establishes a singleton default convention.
Use one camelCase Awilix token per dependency (`deliveryService`, `escrowService`,
`deliveryController`). Never register snake_case aliases or two tokens for the same implementation.
The container must point canonical tokens at canonical modules.

## Legacy files

The following files are retained only for compatibility and must not receive new features:

| Legacy file                             | Canonical replacement                    | Status                                      |
| --------------------------------------- | ---------------------------------------- | ------------------------------------------- |
| `src/services/deliveryService.ts`       | `src/services/delivery.service.ts`       | Retained compatibility service (deprecated) |
| `src/controllers/deliveryController.ts` | `src/controllers/delivery.controller.ts` | Compatibility shim re-export (deprecated)   |
| `src/models/deliveryModel.ts`           | `src/models/Delivery.ts`                 | Retained legacy model (deprecated)          |

Each retained legacy file has a deprecation banner. The former `src/services/escrowService.ts`,
`src/controllers/deliveryCrudController.ts`, and `src/sockets/index.ts` have been removed; use their
canonical replacements and do not recreate removed parallel stacks.

Before adding a file, search `src/` for the canonical implementation and update it when one exists.
