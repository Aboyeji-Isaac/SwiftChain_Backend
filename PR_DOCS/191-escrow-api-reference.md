# PR: Escrow API Reference (Closes #191)

## Summary

Document the existing SwiftChain escrow API and its operational behavior so
frontend, indexer, and backend contributors can integrate against the actual
route contracts and state transitions.

## Related Issue

Closes #191

## What changed

- Added `backend/docs/api/escrow.md` with request and response details, auth
  behavior, status/error codes, and cURL examples for escrow fund/query/sync/
  release, escrow indexer sync/query, admin expired-escrow review/resolution,
  escrow-lock transaction preparation/submission, and proof-of-delivery upload.
- Documented the escrow lifecycle, including pending, locked, released,
  refunded, disputed, expired, and resolved states.
- Explained the Redlock resource naming (`escrow:release:<escrowId>`), release
  guards, proof-of-delivery requirement, delivery completion effect,
  `Idempotency-Key` behavior, and HTTP 409 conflict handling.
- Described `tx_bad_seq` recovery for signed escrow-lock submission.
- Called out current route authentication and behavior differences visible in
  the implementation, including unauthenticated fund/indexer routes and the
  absence of a dispute-state transition in the documented handlers.

## Files of interest

- `backend/docs/api/escrow.md`

## Verification

- `./node_modules/.bin/prettier --check backend/docs/api/escrow.md` — passed.
- Runtime tests were not run; this PR changes documentation only.
- The `npx pnpm` wrapper hit pnpm's ignored-build approval check before running
  Prettier. The local Prettier binary was used for the successful check.

## Checklist

- [x] Documentation reflects the current routes and service behavior.
- [x] Examples use placeholders; no credentials or inline integration mocks
      were added.
- [x] API paths are versioned under `/api/v1`.
- [x] PR references the issue with `Closes #191`.
- [ ] Attach a screenshot of the successful documentation check as proof of
      work before submission.

## Proof of Work

Attach a screenshot showing the successful output of:

```bash
./node_modules/.bin/prettier --check backend/docs/api/escrow.md
```

No screenshot is included in this draft.
