# Stellar Event Indexer and Event-Ingestion Pipeline

## Overview

SwiftChain consumes Stellar/Soroban ledger events and synchronizes relevant blockchain state into MongoDB.

The current architecture consists of:

```text
Soroban Network
      |
      v
Soroban RPC getEvents()
      |
      v
Indexer / Event Handlers
      |
      +---- escrow handlers
      +---- delivery handlers
      +---- dispute handlers
      +---- reputation handlers
      |
      v
EventLog / domain services
      |
      v
MongoDB
      |
      v
IndexerStatus
      |
      v
Lag Monitor / IndexerAlert
```

Primary implementation files:

```text
src/models/EventLog.ts
src/services/eventLogService.ts
src/services/eventPoller.ts
src/services/monitorService.ts
src/models/IndexerStatus.ts
src/models/IndexerAlert.ts
src/indexer/escrowHandlers.ts
src/indexer/deliveryHandlers.ts
src/indexer/disputeHandlers.ts
src/indexer/reputationHandlers.ts
src/routes/eventLogRoutes.ts
src/routes/monitorRoutes.ts
```

---

# EventLog Model

`EventLog` persists indexed blockchain events.

Schema:

```ts
interface IEventLog {
  eventType: string;
  transactionHash: string;
  ledgerSequence: number;
  contractId?: string;
  eventData?: Record<string, any>;
  processedAt: Date | null;
  status: 'pending' | 'processed' | 'failed';
  errorMessage?: string | null;
  createdAt: Date;
  updatedAt: Date;
}
```

Supported `eventType` values in the current model:

```text
delivery
escrow
dispute
reputation
milestone
```

---

# Event Deduplication

The primary deduplication contract is:

```text
(transactionHash, eventType)
```

MongoDB enforces uniqueness through:

```ts
EventLogSchema.index(
  { transactionHash: 1, eventType: 1 },
  { unique: true },
);
```

This prevents the same transaction/event category combination from being persisted more than once.

The event service also exposes:

```ts
eventExists(transactionHash, eventType)
```

Before creating an event, `EventLogService.createEventLog()` checks whether the event already exists.

---

# Event Status Lifecycle

Events begin as:

```text
pending
```

Successful processing changes the status to:

```text
processed
```

Processing failures can be recorded as:

```text
failed
```

Lifecycle:

```text
               +----------------+
               |    pending     |
               +-------+--------+
                       |
              successful processing
                       |
                       v
               +----------------+
               |   processed    |
               +----------------+

               +----------------+
               |    pending     |
               +-------+--------+
                       |
                  processing error
                       |
                       v
               +----------------+
               |     failed     |
               +----------------+
```

When an event is saved with:

```text
status = processed
```

the model's pre-save middleware populates `processedAt` if it is not already set.

---

# EventLog Queries

`EventLogService` provides:

```ts
createEventLog()
markAsProcessed()
getLastProcessedLedger()
getUnprocessedEvents()
getEventsByLedgerRange()
getEventByTransactionHash()
markEventFailed()
```

Unprocessed events are queried using:

```text
status = pending
```

and ordered by:

```text
createdAt ASC
```

with a maximum of 100 results per call.

---

# Last Processed Ledger

`getLastProcessedLedger(eventType?)` returns the highest ledger sequence belonging to a processed event.

Without an event type:

```text
latest processed ledger across all processed events
```

With an event type:

```text
latest processed ledger for that event category
```

If no processed event exists, the service returns:

```text
0
```

---

# EventLog API

The event-log routes are mounted under the application's `/api/v1/eventlog` route group.

## Get Last Processed Ledger

```text
GET /api/v1/eventlog/last-processed
```

Authentication:

```text
JWT required
```

---

## Get Unprocessed Events

```text
GET /api/v1/eventlog/unprocessed
```

Roles:

```text
ADMIN
ENTERPRISE
```

---

## Get Events by Ledger Range

```text
GET /api/v1/eventlog/range
```

Roles:

```text
ADMIN
ENTERPRISE
```

The service supports:

```text
startLedger
endLedger
eventType
```

for range filtering.

---

## Get Event by Transaction Hash

```text
GET /api/v1/eventlog/transaction/:hash
```

Authentication:

```text
JWT required
```

---

# Escrow Event Handling

Escrow events are implemented in:

```text
src/indexer/escrowHandlers.ts
```

The currently implemented event handlers include:

```text
escrow_funded
escrow_released
escrow_refunded
```

---

## `escrow_funded`

The expected topic structure is:

```text
[escrow_funded, delivery_id]
```

The event data includes values such as:

```text
amount
asset
funded_by
asset_issuer
```

The handler validates and parses the event before passing the result to the escrow service.

The RPC query uses a contract filter and the configured:

```text
ESCROW_CONTRACT_ID
```

and:

```text
ESCROW_FUNDED_EVENT_TOPIC
```

The default funded event topic is:

```text
escrow_funded
```

---

## `escrow_released`

Expected topics:

```text
[escrow_released, escrow_id]
```

Expected event data includes:

```text
amount
asset
recipient
transaction_hash
ledger
timestamp
```

The event is delegated to:

```text
escrowIndexerService.handleEscrowReleased()
```

---

## `escrow_refunded`

Expected topics:

```text
[escrow_refunded, escrow_id]
```

The event data follows the escrow-resolution structure:

```text
amount
asset
recipient
transaction_hash
ledger
timestamp
```

The event is delegated to:

```text
escrowIndexerService.handleEscrowRefunded()
```

---

# Delivery Event Handling

Implementation:

```text
src/indexer/deliveryHandlers.ts
```

Supported handlers include:

```text
delivery_created
delivery_status_updated
```

## `delivery_created`

The event data is decoded from Soroban XDR and must provide:

```text
delivery_id
contract_id
```

The handler links the local delivery record to the on-chain contract.

---

## `delivery_status_updated`

The event must provide:

```text
delivery_id
status
```

The status is checked against the backend's `DeliveryStatus` enum before updating the local delivery.

Unknown statuses are logged and ignored.

---

# Dispute Event Handling

Implementation:

```text
src/indexer/disputeHandlers.ts
```

Supported events:

```text
dispute_opened
dispute_resolved
```

---

## `dispute_opened`

Expected event information includes:

```text
disputeId
deliveryId
openedBy
reason
ledgerSequence
```

The handler creates the corresponding local dispute record.

If `DISPUTE_NOTIFICATION_WEBHOOK_URL` is configured, an external notification is also sent.

---

## `dispute_resolved`

Expected event information includes:

```text
disputeId
resolution
ledgerSequence
```

The handler updates the local dispute.

A missing dispute is treated as a possible ordering anomaly rather than automatically crashing the indexer.

---

# Reputation Event Handling

Implementation:

```text
src/indexer/reputationHandlers.ts
```

Supported events:

```text
reputation_increased
reputation_slashed
```

The expected topics for reputation events are:

```text
[event_type, driver_address]
```

Event data contains:

```text
points
```

---

## `reputation_increased`

The handler:

1. Validates the driver address.
2. Validates that points are positive.
3. Updates the driver's reputation points.
4. Recalculates the driver's tier.
5. Records the processed ledger.

---

## `reputation_slashed`

The handler:

1. Validates the driver address.
2. Validates that points are positive.
3. Loads the driver's profile.
4. Reduces reputation points without allowing the value below zero.
5. Recalculates the tier.
6. Records the processed ledger.

---

# Idempotent Domain Synchronization

Indexer handlers should delegate state changes to domain services where available.

The important invariant is:

```text
same blockchain event
      +
same transaction hash
      +
same event type
      =
one persisted EventLog entry
```

This prevents repeated ledger polling from producing uncontrolled duplicate records.

---

# IndexerStatus

The lag monitor uses:

```text
src/models/IndexerStatus.ts
```

The checkpoint records the current network and the last processed ledger.

Conceptually:

```text
IndexerStatus
├── network
├── lastProcessedLedger
└── lastProcessedAt
```

---

# `recordProcessedLedger`

The monitor service exposes:

```ts
recordProcessedLedger(ledgerSequence)
```

The function advances the checkpoint only when the new ledger is greater than the existing checkpoint.

This prevents an older event processed after a newer event from moving the checkpoint backwards.

If no checkpoint exists, the function creates one.

---

# `getOrCreateIndexerStatus`

The monitor first attempts to load the checkpoint for the configured Stellar network.

If no checkpoint exists:

1. Fetch the current network ledger.
2. Create an `IndexerStatus`.
3. Use that ledger as the initial checkpoint.

This provides a known starting point for lag monitoring.

---

# Indexer Lag Monitoring

Implementation:

```text
src/services/monitorService.ts
```

The monitor compares:

```text
networkLedger
```

against:

```text
processedLedger
```

Lag is:

```text
lagLedgers = networkLedger - processedLedger
```

Negative values are normalized to zero.

The alert threshold is:

```text
INDEXER_LAG_ALERT_THRESHOLD
```

Default:

```text
100 ledgers
```

---

# Lag Check Result

The monitor produces:

```ts
interface IndexerLagCheckResult {
  network: string;
  processedLedger: number;
  networkLedger: number;
  lagLedgers: number;
  thresholdLedgers: number;
  breached: boolean;
  checkedAt: string;
}
```

---

# IndexerAlert

When the configured threshold is exceeded, an `IndexerAlert` record is persisted.

The record contains:

```text
network
processedLedger
networkLedger
lagLedgers
thresholdLedgers
webhookConfigured
webhookNotified
webhookError
createdAt
updatedAt
```

Alerts are indexed by:

```text
network + createdAt
```

with recent alerts returned first.

---

# Lag Webhook

When:

```text
INDEXER_LAG_WEBHOOK_URL
```

is configured and the lag threshold is breached, the monitor sends:

```json
{
  "event": "indexer_lag_alert",
  "network": "testnet",
  "processedLedger": 1000,
  "networkLedger": 1120,
  "lagLedgers": 120,
  "thresholdLedgers": 100,
  "breached": true,
  "checkedAt": "2026-09-30T10:30:00.000Z"
}
```

Webhook success/failure is recorded on the corresponding `IndexerAlert`.

---

# Monitor Schedule

The lag monitor runs periodically using:

```text
INDEXER_LAG_CHECK_INTERVAL_MS
```

Default:

```text
60000 ms
```

The monitor interval is released with `.unref()` so it does not prevent process shutdown.

---

# Monitor API

## Current Lag

```text
GET /api/v1/monitor/indexer-lag
```

Authentication:

```text
JWT required
```

Role:

```text
ADMIN
```

This route runs an on-demand lag check.

---

## Alert History

```text
GET /api/v1/monitor/indexer-lag/alerts
```

Authentication:

```text
JWT required
```

Role:

```text
ADMIN
```

This route returns recent persisted indexer-lag alerts.

---

# Current Poller Status

The repository currently contains:

```text
src/services/eventPoller.ts
```

Its current implementation is a stub:

```ts
export const startEventPoller = (): void => {
  logger.info('Event poller started (stub)');
};

export const stopEventPoller = (): void => {
  logger.info('Event poller stopped (stub)');
};
```

Therefore, this file is the explicit replacement point for the planned continuous event-polling implementation.

The current repository should not document `eventPoller.ts` as an active continuous `getEvents()` loop.

---

# Planned `getEvents()` Polling Loop

The intended replacement should follow this shape:

```text
startEventPoller()
       |
       v
load last processed checkpoint
       |
       v
calculate next start ledger
       |
       v
Soroban RPC getEvents()
       |
       v
receive event batch
       |
       v
deduplicate
       |
       v
persist / dispatch events
       |
       v
advance processed checkpoint
       |
       v
repeat
```

The implementation should preserve the following properties:

* Persisted progress.
* Safe restart after process failure.
* Event deduplication.
* Bounded event processing.
* Correct ledger advancement.
* Retry handling for transient RPC failures.
* Graceful shutdown.
* No checkpoint advancement past events that have not been successfully processed.

---

# Planned Polling Integration

The existing escrow implementation already demonstrates the Soroban RPC polling primitive:

```ts
await sorobanRpcClient.getEvents({
  startLedger,
  filters: [
    {
      type: 'contract',
      contractIds: [contractId],
      topics: [
        [
          xdr.ScVal.scvSymbol(eventTopic).toXDR('base64'),
          '*',
        ],
      ],
    },
  ],
});
```

The future generalized poller can use this same Soroban RPC `getEvents()` mechanism while dispatching returned events to the appropriate domain handlers.

---

# Recommended Pipeline Contract

The target architecture should remain:

```text
getEvents()
    |
    v
raw Soroban event
    |
    v
event classifier
    |
    +---- escrow
    +---- delivery
    +---- dispute
    +---- reputation
    |
    v
EventLog dedupe
    |
    v
domain handler
    |
    v
mark processed
    |
    v
advance checkpoint
```

Checkpoint advancement should occur only after the corresponding event processing has reached its successful completion condition.

---

# Source of Truth

```text
src/models/EventLog.ts
src/services/eventLogService.ts
src/services/eventPoller.ts
src/services/monitorService.ts
src/models/IndexerStatus.ts
src/models/IndexerAlert.ts
src/indexer/escrowHandlers.ts
src/indexer/deliveryHandlers.ts
src/indexer/disputeHandlers.ts
src/indexer/reputationHandlers.ts
src/routes/eventLogRoutes.ts
src/routes/monitorRoutes.ts
TODO.md
```

# Pull Request

## Title

```text
docs: add webhook, realtime, Stellar, and indexer integration references
```

## Summary

```text
## Summary

- Add the Webhook API reference covering subscriptions, HMAC-SHA256 signing, secret rotation, delivery attempts, and retries.
- Add the Socket.IO realtime protocol reference covering authentication, rooms, location events, offline sync, ACKs, and token refresh.
- Add the Stellar/Soroban integration guide covering network configuration, RPC resilience, circuit breakers, XDR generation, stroop conversion, and tx_bad_seq recovery.
- Add the indexer reference covering EventLog deduplication, event handlers, ledger checkpoints, lag monitoring, alerts, and the current event-poller replacement point.

## Issues

Closes #192
Closes #193
Closes #194
Closes #195

## Files

- `backend/docs/api/webhooks.md`
- `backend/docs/socket-protocol.md`
- `backend/docs/stellar-integration.md`
- `backend/docs/indexer.md`

## Implementation Notes

Documentation-only change. No runtime application behavior is modified.
```
