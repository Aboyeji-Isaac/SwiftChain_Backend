# Event Poller Implementation - TODO

## Steps

- [x] 1. Create `src/models/EventLog.ts` — Mongoose model to persist last processed ledger per event type
- [x] 2. Create `src/services/eventPoller.ts` — Continuous polling loop with event dispatch
- [x] 3. Edit `src/server.ts` — Integrate start/stop of event poller
- [x] 4. Verify TypeScript compilation (`npx tsc --noEmit`). Only error: a stray line in `tests/deliveryStatusTransition.test.ts:96`, which is also on `main`.
- [x] 5. Run existing tests. The 14 failing suites also fail on `main` (see PR description); no new failing suites.
- [x] 6. Replace the stub with the `getEvents` ingestion loop (`EventLog` dedupe, handler dispatch, `IndexerStatus` checkpoint). See `backend/docs/indexer.md`.
- [ ] 7. Retry failed `EventLog` records. Not implemented yet.
- [ ] 8. Subscribe the delivery, dispute, reputation and milestone handlers to the poller.

