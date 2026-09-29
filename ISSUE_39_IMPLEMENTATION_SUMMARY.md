# Issue #39: Escrow Resolution Event Handlers Implementation

## Summary

Implemented complete indexer handlers for `escrow_released` and `escrow_refunded` Soroban contract events. The implementation follows the existing codebase architecture with a layered pattern: Handlers → Service → Model.

## Files Created

### 1. **src/indexer/types/escrowEvents.ts**
- Defines `EscrowResolvedEvent` interface for typed resolution events
- Exports `EscrowResolutionEventType` ('escrow_released' | 'escrow_refunded')
- Exports `TERMINAL_STATUSES` constant for status transition validation
- Exported `EscrowStatus` type for consistency with model

**Key Interfaces:**
```typescript
export interface EscrowResolvedEvent {
  type: EscrowResolutionEventType;
  escrowId: string;
  transactionHash: string;
  amount: string;
  asset: string;
  ledger: number;
  timestamp: number;
  recipient: string;
}
```

### 2. **src/services/escrowIndexerService.ts**
- Service layer for escrow resolution DB operations
- Implements idempotent `handleEscrowReleased()` and `handleEscrowRefunded()` methods
- Implements `getEscrowByEscrowId()` for querying

**Key Methods:**
- `handleEscrowReleased(event)` — Updates status to 'released', records settlement tx hash, records transaction
- `handleEscrowRefunded(event)` — Updates status to 'refunded', records settlement tx hash, records transaction
- `getEscrowByEscrowId(escrowId)` — Retrieves escrow by ObjectId or contract ID

**Idempotency Strategy:**
- Checks if transaction hash already exists in transactions array
- Uses MongoDB `$nin` operator to prevent updating terminal statuses
- Safely re-processes ledger ranges without duplicate side effects

### 3. **src/indexer/escrowHandlers.ts** (Updated)
- Added `parseEscrowResolutionEvent()` to parse Soroban contract events
- Added `handleEscrowReleasedEvent()` async handler
- Added `handleEscrowRefundedEvent()` async handler
- Added `syncEscrowReleasedEvents()` to poll RPC for released events
- Added `syncEscrowRefundedEvents()` to poll RPC for refunded events

**Event Shape (Contract):**
```
topics: [Symbol("escrow_released"|"escrow_refunded"), Bytes escrow_id]
data: Map {
  amount: i128,
  asset: Symbol|Address,
  recipient: Address,
  transaction_hash: Bytes,
  ledger: u32,
  timestamp: u64
}
```

### 4. **src/controllers/escrowIndexerController.ts**
- HTTP request handlers for indexer endpoints
- `getEscrowStatus(escrowId)` — GET /api/v1/indexer/escrows/:escrowId
- `syncReleased(startLedger, contractId)` — POST /api/v1/indexer/escrows/sync/released
- `syncRefunded(startLedger, contractId)` — POST /api/v1/indexer/escrows/sync/refunded

### 5. **src/routes/escrowIndexer.routes.ts**
- Express router for indexer endpoints
- Mounted at `/v1/indexer` in main router
- Includes OpenAPI documentation comments

**Routes:**
- `GET /escrows/:escrowId` — Retrieve escrow status
- `POST /escrows/sync/released` — Trigger escrow_released event sync
- `POST /escrows/sync/refunded` — Trigger escrow_refunded event sync

### 6. **src/routes/index.ts** (Updated)
- Added import: `import escrowIndexerRoutes from './escrowIndexer.routes'`
- Registered: `router.use('/v1/indexer', escrowIndexerRoutes)`

### 7. **tests/escrowIndexer.test.ts**
- Comprehensive unit tests (16 test cases)
- Covers event parsing, handler logic, and service layer integration
- Uses MongoDB Memory Server for integration testing
- Mocks logger to isolate business logic

**Test Coverage:**
- `parseEscrowResolutionEvent` — 5 tests
  - Well-formed released/refunded events
  - Missing topic, missing fields, invalid amount
- `handleEscrowReleasedEvent` — 4 tests
  - Update with DB persistence
  - Idempotency on repeated tx hash
  - No update to already-released escrow
  - Parse failure handling
- `handleEscrowRefundedEvent` — 4 tests
  - Update with DB persistence
  - Idempotency on repeated tx hash
  - No update to already-refunded escrow
  - Parse failure handling (implicit)
- `escrowIndexerService` — 3 tests
  - `getEscrowByEscrowId` by ObjectId and contract ID
  - `handleEscrowReleased` service method
  - `handleEscrowRefunded` service method

## Architecture

### Layered Design
```
HTTP Request
    ↓
Controller (escrowIndexerController)
    ↓
Service (escrowIndexerService)
    ↓
Model (Escrow)
    ↓
MongoDB
```

### Event Processing Flow
```
Soroban RPC Contract Event
    ↓
parseEscrowResolutionEvent() — Parse to typed event
    ↓
handleEscrowReleasedEvent() / handleEscrowRefundedEvent() — Route to service
    ↓
escrowIndexerService.handleEscrowReleased() / handleEscrowRefunded() — DB update
    ↓
Escrow.findOneAndUpdate() — Persist to MongoDB
```

### Idempotency Guarantees
1. **Transaction Hash Deduplication** — Checks if transaction already recorded
2. **Terminal Status Check** — Uses `$nin` to prevent updating released/refunded escrows
3. **Atomic Update** — Single findOneAndUpdate operation ensures consistency

## API Endpoints

### 1. GET /api/v1/indexer/escrows/{escrowId}
Retrieve current escrow status from database.

**Parameters:**
- `escrowId` (path, required) — MongoDB ObjectId or contract ID

**Response:** 200 OK
```json
{
  "success": true,
  "data": {
    "_id": "...",
    "status": "released",
    "releaseTransactionHash": "...",
    "releasedAt": "2024-09-01T...",
    "transactions": [...]
  },
  "message": "Escrow status retrieved successfully"
}
```

### 2. POST /api/v1/indexer/escrows/sync/released
Poll Soroban RPC for escrow_released events.

**Body:**
```json
{
  "startLedger": 100000,
  "contractId": "CESCROWCONTRACT" // optional
}
```

**Response:** 200 OK
```json
{
  "success": true,
  "data": {
    "latestLedger": 100050,
    "cursor": "...",
    "processed": 5,
    "ignored": 2,
    "results": [...]
  },
  "message": "Escrow released events synced successfully"
}
```

### 3. POST /api/v1/indexer/escrows/sync/refunded
Poll Soroban RPC for escrow_refunded events.

**Body:** Same as `/sync/released`

**Response:** Same structure as `/sync/released`

## Status Updates

- `LOCKED` → `RELEASED` on escrow_released event
- `LOCKED` → `REFUNDED` on escrow_refunded event
- Other statuses remain unchanged (terminal status prevention)

## Error Handling

- Malformed events are parsed to `null` and skipped
- Database errors are logged and re-thrown
- Controllers catch and delegate to Express error middleware
- All operations are safe to retry (idempotent)

## Acceptance Criteria Verification

✅ Controller → Service → Model layered architecture  
✅ EscrowResolvedEvent typed interface  
✅ handleEscrowReleased updates status='released' + settlementTxHash  
✅ handleEscrowRefunded updates status='refunded' + settlementTxHash  
✅ Idempotent: $nin condition prevents double-update  
✅ Malformed events logged and skipped (no crash)  
✅ GET /api/v1/indexer/escrows/:escrowId route returns DB data  
✅ API versioned at /api/v1/  
✅ No inline mocks or hardcoded values in integration code  
✅ All 16 tests (7+ required) pass  
✅ npm run build passes  
✅ npm run lint passes  

## Dependencies

No new external dependencies added. Implementation uses existing libraries:
- `@stellar/stellar-sdk` — Soroban RPC and XDR parsing
- `mongoose` — MongoDB driver
- `express` — HTTP server
- `winston` — Logging

## Testing

Run tests with:
```bash
npm test -- tests/escrowIndexer.test.ts
```

All 16 test cases verify:
- Event parsing correctness
- Handler delegation logic
- Service layer idempotency
- Database update accuracy
- Terminal status enforcement
- Error handling and logging

## Deployment Notes

1. Ensure `ESCROW_CONTRACT_ID` is set in environment
2. Soroban RPC URL must be configured (`SOROBAN_RPC_URL`)
3. Routes are automatically registered at `/api/v1/indexer`
4. No database migrations required (Escrow model already has all fields)
5. Handlers are stateless and can run in parallel safely (idempotent)

## Future Enhancements

- Add scheduled job to auto-poll for resolution events
- Add event webhook notifications
- Add audit logging for escrow transitions
- Add metrics/monitoring for event processing latency
