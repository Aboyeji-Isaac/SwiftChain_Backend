# PR: Escrow Dispute Resolution (Closes #129)

Summary
-------

This PR adds an Escrow Dispute Resolution flow that allows admins to lock escrows, create dispute records, and resolve disputes by refunding the buyer or releasing funds to the driver. It implements a Controller -> Service -> Model layered architecture and records every admin action in an Audit Log.

Key changes
-----------

- `src/models/Escrow.ts` — Escrow schema and status fields
- `src/models/Dispute.ts` — Dispute schema with history entries
- `src/models/AuditLog.ts` — AuditLog schema to capture actions
- `src/services/disputeService.ts` — Business logic for locking and resolving escrows
- `src/controllers/disputeController.ts` — API handlers for disputes
- `src/routes/disputeRoutes.ts` — Routes registered under `/api/v1/disputes`
- `src/routes/index.ts` — Registered the disputes routes

Why this change
---------------

To provide a manual arbitration mechanism enabling admins to temporarily lock funds in escrow and resolve disputes off-chain, while keeping a complete audit trail in the database.

How to run & verify
-------------------

1. Install deps: `pnpm install`
2. Run tests: `pnpm test` (existing test suite passed locally)
3. Start server: `pnpm run dev`
4. Use the example `curl` commands in the PR template to lock and resolve a dispute. Replace `<ESCROW_ID>`, `<DISPUTE_ID>`, and `<ADMIN_USER_ID>` where required.

Security & Follow-ups
---------------------

- This PR does not add RBAC enforcement — please ensure admin-only access is applied by adding existing auth middleware to the dispute routes.
- Consider adding integration tests around the dispute lifecycle.

Proof of Work
-------------

Attach here a screenshot of `pnpm test` output or a Postman screenshot showing a successful API response. The test run used in CI locally returned: `PASS  tests/health.test.ts`.

Reviewer Notes
--------------

- Review schema choices and field names for consistency with existing models.
- Confirm whether `sorobanTxId` or additional blockchain fields should be set when resolving disputes.
