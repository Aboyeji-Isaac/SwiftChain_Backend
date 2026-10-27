# Data Migration and Backfill Runbook

## Purpose

This runbook defines the safe procedure for MongoDB schema migrations, legacy-data normalization, EventLog backfills, index maintenance, and demo-data reseeding in SwiftChain Backend.

The migration workflow is:

```text
Backup → Dry Run → Throttle → Apply → Verify → Monitor → Rollback if required
```

> **Repository note:** the requested documentation location is `backend/docs/`. The application models and seed script currently live under the repository-root `src/` directory, including `src/models/Delivery.ts`, `src/models/EventLog.ts`, and `src/seed.ts`.

---

## 1. Pre-Migration Checklist

Before changing production data:

* [ ] Confirm the migration target and affected collection.
* [ ] Confirm the migration has been reviewed and approved.
* [ ] Confirm the deployment window.
* [ ] Confirm a recent MongoDB backup exists and is restorable.
* [ ] Record current document counts.
* [ ] Record current index definitions.
* [ ] Run the migration in dry-run mode against a staging copy.
* [ ] Estimate the number of documents to modify.
* [ ] Define batch size and throttle interval.
* [ ] Define expected post-migration invariants.
* [ ] Define rollback criteria.
* [ ] Confirm application compatibility with both old and new data formats.
* [ ] Confirm no destructive operation is being executed without a verified backup.

### Baseline queries

```javascript
db.deliveries.countDocuments({})
db.eventlogs.countDocuments({})

db.deliveries.aggregate([
  { $group: { _id: "$status", count: { $sum: 1 } } },
  { $sort: { _id: 1 } }
])

db.eventlogs.aggregate([
  { $group: { _id: "$eventType", count: { $sum: 1 } } },
  { $sort: { _id: 1 } }
])
```

Capture these values before and after the migration.

---

## 2. Backup

Create a backup before production migration work.

Example:

```bash
mongodump \
  --uri="$MONGODB_URI" \
  --db="$(echo "$MONGODB_URI" | sed -E 's/.*\/([^/?]+).*/\1/')" \
  --out="./backup/$(date +%Y%m%d-%H%M%S)"
```

Verify that the backup contains the expected collections before continuing.

For production environments, use the organization's managed MongoDB backup/snapshot mechanism where applicable.

---

## 3. Legacy Delivery Status Migration

The current canonical delivery statuses are defined in:

```text
src/models/Delivery.ts
```

Canonical values include:

```text
pending
funded
assigned
in_progress
completed
cancelled
```

### Legacy-to-canonical mapping

| Legacy status | Canonical status | Migration note                                              |
| ------------- | ---------------- | ----------------------------------------------------------- |
| `picked_up`   | `in_progress`    | Delivery has left pickup and is actively being transported. |
| `in_transit`  | `in_progress`    | Delivery is actively being transported.                     |
| `delivered`   | `completed`      | Delivery has reached its completed state.                   |

No legacy value should be silently converted to `pending`, `funded`, `assigned`, or `cancelled`.

### Dry-run query

```javascript
db.deliveries.aggregate([
  {
    $match: {
      status: {
        $in: ["picked_up", "in_transit", "delivered"]
      }
    }
  },
  {
    $group: {
      _id: "$status",
      count: { $sum: 1 }
    }
  }
])
```

### Migration outline

Use a bounded batch operation rather than modifying an unbounded production collection in one request.

```javascript
const statusMap = {
  picked_up: "in_progress",
  in_transit: "in_progress",
  delivered: "completed"
};

for (const [legacyStatus, canonicalStatus] of Object.entries(statusMap)) {
  const result = await db.deliveries.updateMany(
    { status: legacyStatus },
    { $set: { status: canonicalStatus } }
  );

  console.log({
    legacyStatus,
    canonicalStatus,
    modifiedCount: result.modifiedCount
  });
}
```

For large collections, process `_id` ranges or limited batches and pause between batches.

### Post-migration validation

```javascript
db.deliveries.countDocuments({
  status: {
    $in: ["picked_up", "in_transit", "delivered"]
  }
})
```

Expected result:

```text
0
```

Then verify the canonical distribution:

```javascript
db.deliveries.aggregate([
  { $group: { _id: "$status", count: { $sum: 1 } } },
  { $sort: { _id: 1 } }
])
```

---

## 4. EventLog Backfill

The EventLog model is:

```text
src/models/EventLog.ts
```

The model stores:

* `eventType`
* `transactionHash`
* `ledgerSequence`
* `contractId`
* `eventData`
* `processedAt`
* `status`
* timestamps

EventLog has a unique compound index on:

```javascript
{ transactionHash: 1, eventType: 1 }
```

This uniqueness constraint is the primary database-level deduplication mechanism for backfills.

### Backfill flow

```text
Determine ledger range
        ↓
Read on-chain events
        ↓
Normalize event type/data
        ↓
Check transactionHash + eventType
        ↓
Insert missing EventLog record
        ↓
Mark processed when successfully handled
        ↓
Record failed events for retry
```

### Determine the starting ledger

Use the latest successfully processed ledger for the relevant event type:

```typescript
const lastProcessedLedger =
  await EventLog.getLastProcessedLedger(eventType);
```

For an initial backfill, define an explicit starting ledger rather than assuming the current ledger.

### Event insertion

Backfill records should preserve the original transaction hash and ledger sequence.

```typescript
await EventLog.updateOne(
  {
    transactionHash: event.transactionHash,
    eventType: event.eventType,
  },
  {
    $setOnInsert: {
      transactionHash: event.transactionHash,
      eventType: event.eventType,
      ledgerSequence: event.ledgerSequence,
      contractId: event.contractId,
      eventData: event.eventData,
      status: 'pending',
      processedAt: null,
    },
  },
  { upsert: true },
);
```

Using `upsert` with `$setOnInsert` allows the migration to be safely retried without replacing an existing event record.

### Dedupe verification

```javascript
db.eventlogs.aggregate([
  {
    $group: {
      _id: {
        transactionHash: "$transactionHash",
        eventType: "$eventType"
      },
      count: { $sum: 1 }
    }
  },
  {
    $match: {
      count: { $gt: 1 }
    }
  }
])
```

Expected result:

```text
No duplicate groups
```

---

## 5. Index Maintenance

Inspect indexes before rebuilding:

```javascript
db.deliveries.getIndexes()
db.eventlogs.getIndexes()
db.driverlocations.getIndexes()
```

### Sparse indexes

Example:

```javascript
db.deliveries.createIndex(
  { trackingNumber: 1 },
  { unique: true, sparse: true, name: "trackingNumber_1_sparse" }
)
```

Sparse indexes should only be used when documents without the indexed field must be excluded from the index.

### Partial indexes

Example pattern:

```javascript
db.deliveries.createIndex(
  { deletedAt: -1 },
  {
    partialFilterExpression: {
      isDeleted: true
    },
    name: "deletedAt_1_deleted_partial"
  }
)
```

Verify the existing application query semantics before replacing an index with a partial index.

### TTL indexes

Example:

```javascript
db.collection.createIndex(
  { createdAt: 1 },
  {
    expireAfterSeconds: 86400,
    name: "createdAt_1_ttl"
  }
)
```

TTL indexes must only be applied to collections where automatic expiration is explicitly intended.

### 2dsphere indexes

For GeoJSON location data:

```javascript
db.collection.createIndex(
  { location: "2dsphere" },
  { name: "location_2dsphere" }
)
```

Validate existing documents before creating the index because malformed GeoJSON can prevent index creation.

### Safe index replacement

```javascript
db.collection.getIndexes()
db.collection.dropIndex("old_index_name")
db.collection.createIndex(
  { field: 1 },
  { name: "new_index_name" }
)
```

For large production collections, schedule index maintenance during an approved maintenance window and monitor database load.

---

## 6. Demo Environment Reseeding

The repository seed script is:

```text
src/seed.ts
```

Run:

```bash
pnpm run seed
```

The current seed implementation removes existing delivery documents before inserting its demo delivery:

```typescript
await Delivery.deleteMany({});
await Delivery.create(delivery);
```

Therefore, the current seed process is **repeatable for its demo dataset but destructive to existing delivery records in the target database**.

It must only be used against disposable/demo environments unless the implementation is explicitly changed to use scoped, idempotent upserts.

### Recommended safe demo workflow

```bash
export NODE_ENV=development
export MONGODB_URI="mongodb://localhost:27017/swiftchain_demo"
pnpm run seed
```

Verify:

```javascript
db.deliveries.countDocuments({
  deliveryId: "DEL-001"
})
```

Expected:

```text
1
```

Do not run the current seed command against production.

---

## 7. Verification Checklist

After every migration:

* [ ] Migration process completed without unhandled errors.
* [ ] Expected number of records changed.
* [ ] No legacy delivery statuses remain.
* [ ] EventLog transaction/event uniqueness is preserved.
* [ ] EventLog ledger sequence continuity was checked for the migration range.
* [ ] Indexes exist with the expected definitions.
* [ ] Application queries continue to return expected results.
* [ ] Application health check succeeds.
* [ ] Error logs show no migration-related failures.
* [ ] Relevant API smoke tests pass.
* [ ] Migration results have been recorded.

---

## 8. Rollback

Rollback depends on the migration type.

### Data rollback

For destructive transformations, restore the affected collection/database from the verified backup.

```bash
mongorestore \
  --uri="$MONGODB_URI" \
  --drop \
  ./backup/<timestamp>
```

Do not use `--drop` against production without confirming the exact target database and restore scope.

### Status rollback

If the migration only changed delivery status values, reverse only the affected records using a migration-specific backup or audit dataset.

Do not infer the original status after the fact when multiple legacy states mapped to the same canonical state.

### EventLog rollback

For backfilled EventLog records, identify the exact migration window and event source before deletion. Never delete EventLog records globally to undo a failed backfill.

### Index rollback

Recreate the previous index definition before dropping a newly introduced index where possible.

---

## 9. Deployment Integration

Database migrations should be treated as a deployment dependency:

```text
Build
  ↓
Backup
  ↓
Deploy compatible application
  ↓
Dry-run migration
  ↓
Apply migration
  ↓
Verify database
  ↓
Health check
  ↓
Enable normal traffic
```

For backwards-incompatible migrations, use an expand/contract approach:

```text
Expand schema
    ↓
Deploy compatible application
    ↓
Backfill
    ↓
Verify parity
    ↓
Switch reads/writes
    ↓
Remove legacy representation
```
