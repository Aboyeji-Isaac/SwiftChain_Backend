<!-- Title: use conventional commit style: feat|fix|docs|chore(scope): short description -->

## Summary

Provide a concise description of the change and the motivation.

## Related Issue

Closes #129

## What I changed

- Added Escrow, Dispute and AuditLog Mongoose models
- Implemented a `DisputeService` with lock and resolution logic
- Added `DisputeController` and versioned routes under `/api/v1/disputes`
- Added audit logging for admin actions

## Files of interest

- src/models/Escrow.ts
- src/models/Dispute.ts
- src/models/AuditLog.ts
- src/services/disputeService.ts
- src/controllers/disputeController.ts
- src/routes/disputeRoutes.ts
- src/routes/index.ts

## How to test locally

1. Ensure `.env` contains a working `MONGODB_URI` (or run MongoDB locally).
2. Install dependencies:

```bash
pnpm install
```

3. Run tests:

```bash
pnpm test
```

4. Start the dev server:

```bash
pnpm run dev
```

5. Example API calls (adjust host/port if needed):

Lock an escrow (admin):

```bash
curl -X POST http://localhost:3000/api/v1/disputes/<ESCROW_ID>/lock \
  -H "Content-Type: application/json" \
  -d '{"adminId":"<ADMIN_USER_ID>", "reason":"Buyer reports damaged goods"}'
```

Resolve a dispute (refund or release):

```bash
curl -X POST http://localhost:3000/api/v1/disputes/<DISPUTE_ID>/resolve \
  -H "Content-Type: application/json" \
  -d '{"adminId":"<ADMIN_USER_ID>", "action":"refund", "notes":"Refund approved"}'
```

Fetch dispute details:

```bash
curl http://localhost:3000/api/v1/disputes/<DISPUTE_ID>
```

## Acceptance Criteria Mapping

- Controller -> Service -> Model architecture: implemented
- Persistence: data saved to MongoDB; no hardcoded mocks
- API Versioning: endpoints registered under `/api/v1`
- Robust error handling: service and controller validate inputs and return errors

## Checklist

- [ ] Code follows repo conventions and lints
- [ ] Unit/integration tests added for critical logic (could be added in follow-up)
- [x] All existing tests pass
- [x] PR references related issue: Closes #129

## Proof of Work

Attach a screenshot of successful API response or test output. Example: terminal output of `pnpm test` or a Postman request showing success.

## Notes for reviewers

- This PR adds new models and routes; ensure DB indices and migration steps are acceptable.
- Admin authorization is not enforced in this change — recommend adding RBAC middleware in a follow-up.
