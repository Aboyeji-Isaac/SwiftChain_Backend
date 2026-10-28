# MongoDB Performance and Connection-Pooling Guidelines

## Purpose

This document defines the MongoDB performance conventions for SwiftChain_Backend.

The goal is to keep database access predictable as delivery, driver, escrow, webhook, event-indexing, and idempotency workloads grow.

The primary rules are:

* Reuse the application's Mongoose connection instead of creating per-request connections.
* Keep the configured connection pool within the service defaults unless there is a measured reason to change it.
* Prefer `.lean()` for read-only repository queries.
* Select only the fields required by the caller.
* Preserve indexes used by hot queries.
* Avoid N+1 database access patterns.
* Use aggregation `$lookup` deliberately and ensure both sides of the join are indexed.
* Use unordered bulk insertion when partial success is an explicit requirement.
* Verify query plans with `explain()` before introducing or changing a hot query.

---

## 1. MongoDB Connection Lifecycle

The MongoDB connection is created in:

`src/config/database.ts`

The current connection configuration is:

```ts
await mongoose.connect(mongoUri, {
  maxPoolSize: 10,
  minPoolSize: 2,
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
});
```

### Pool configuration

| Setting                    |   Value | Purpose                                                        |
| -------------------------- | ------: | -------------------------------------------------------------- |
| `maxPoolSize`              |    `10` | Maximum number of MongoDB connections maintained by Mongoose   |
| `minPoolSize`              |     `2` | Minimum number of connections kept available                   |
| `serverSelectionTimeoutMS` |  `5000` | Limits server-selection failures to approximately five seconds |
| `socketTimeoutMS`          | `45000` | Closes inactive sockets after 45 seconds                       |

Do not create a new `mongoose.connect()` call inside a controller, service, repository, scheduled job, or request handler.

Application code should use the already-established Mongoose connection.

### Shutdown lifecycle

Transactions and multi-document operations should use:

```ts
startTrackedSession()
```

from `src/config/database.ts`.

Tracked sessions are registered in `activeSessions` so graceful shutdown can wait for active transactions before closing MongoDB.

Database shutdown is handled through:

```ts
disconnectDatabase()
```

which safely closes the existing Mongoose connection.

### Connection rules

```text
Application startup
      |
      v
connectDatabase()
      |
      v
Shared Mongoose connection/pool
      |
      +--> repositories
      +--> services
      +--> scheduled jobs
      +--> controllers
      |
      v
Graceful shutdown
      |
      +--> waitForActiveTransactions()
      |
      v
disconnectDatabase()
```

---

## 2. Read Query Rules

### Prefer `.lean()` for read-only queries

When a query only needs data for serialization, filtering, aggregation preparation, or a response, prefer:

```ts
const deliveries = await Delivery.find(filter)
  .select('deliveryId trackingNumber status driverId createdAt')
  .sort({ createdAt: -1 })
  .lean();
```

Instead of:

```ts
const deliveries = await Delivery.find(filter);
```

`lean()` prevents Mongoose from hydrating full document instances when document methods, getters, setters, or change tracking are not required.

### Do not use `.lean()` when document behavior is required

Avoid `.lean()` when the returned document must:

* call schema instance methods;
* be modified and saved;
* participate in document middleware behavior;
* rely on Mongoose document-specific functionality.

For read-only API responses, `.lean()` should normally be the default.

---

## 3. Projection Rules

Only retrieve fields required by the caller.

Prefer:

```ts
const escrow = await Escrow.findOne({
  delivery: deliveryId,
})
  .select('status amount assetCode contractId releasedAt')
  .lean();
```

Instead of loading the complete document when the endpoint only needs a subset.

For sensitive fields, explicitly exclude them.

Example:

```ts
const webhook = await WebhookSubscription.findById(id)
  .select('-secret')
  .lean();
```

The webhook secret is also configured with `select: false` in the model, providing an additional safety boundary.

### Projection checklist

Before adding a read query, ask:

* Does the caller need the complete document?
* Can `.lean()` be used?
* Can the projection be reduced?
* Does the query return large payload fields unnecessarily?
* Can a repository method return a purpose-specific shape?

---

## 4. Pagination and Query Bounding

Collection endpoints should use the shared query middleware in:

`src/middlewares/queryMiddleware.ts`

The middleware normalizes:

* `page`;
* `limit`;
* `sort`;
* filter operators;
* search;
* `skip`.

The default page is `1`.

The default limit is `20`.

The maximum default limit is `100`.

Do not introduce an endpoint that retrieves an unbounded collection when pagination is appropriate.

Use the shared pagination metadata builder:

```ts
buildPaginationMeta(totalItems, page, limit)
```

The generated metadata contains:

```json
{
  "totalItems": 137,
  "totalPages": 7,
  "currentPage": 1,
  "limit": 20,
  "hasNextPage": true,
  "hasPreviousPage": false,
  "nextPage": 2,
  "previousPage": null
}
```

---

## 5. Canonical Hot-Query Indexes

Indexes are part of the application's data-access contract.

Do not remove or replace an index merely because a query currently appears to work without it.

### Driver proximity

Model:

`src/models/DriverLocation.ts`

Canonical indexes:

```ts
DriverLocationSchema.index(
  { location: '2dsphere' },
  { name: 'location_2dsphere' },
);

DriverLocationSchema.index(
  { isAvailable: 1, status: 1, location: '2dsphere' },
  { name: 'availability_location_2dsphere' },
);

DriverLocationSchema.index(
  { expiresAt: 1 },
  { name: 'driver_location_ttl', expireAfterSeconds: 0 },
);
```

The indexes support:

* unfiltered radius queries;
* available/online driver proximity searches;
* automatic cleanup of stale driver locations.

GeoJSON coordinates are stored as:

```text
[longitude, latitude]
```

not:

```text
[latitude, longitude]
```

The model's `toGeoPoint()` helper owns the conversion from API `{ lat, lng }` values.

---

### Delivery listing and archival

Model:

`src/models/Delivery.ts`

Relevant indexes include:

```ts
DeliverySchema.index({ status: 1, createdAt: -1 });

DeliverySchema.index({ driver: 1, createdAt: -1 });

DeliverySchema.index({ isDeleted: 1, deletedAt: -1 });
```

These indexes support:

* delivery status filtering and newest-first listing;
* driver delivery listing;
* archived delivery lookup.

`deliveryId` and `trackingNumber` are also configured as sparse unique fields and therefore receive unique indexes.

> When changing delivery filters or sort order, verify that the query remains compatible with the relevant index.

---

### Escrow lookup

Model:

`src/models/Escrow.ts`

Important indexes include:

```ts
delivery: { type: Schema.Types.ObjectId, ref: 'Delivery', required: true, unique: true, index: true }

status: {
  type: String,
  enum: Object.values(EscrowStatus),
  default: EscrowStatus.PENDING,
  required: true,
  index: true,
}

contractId: {
  type: String,
  trim: true,
  unique: true,
  sparse: true,
}

expiresAt: {
  type: Date,
  index: true,
}

EscrowSchema.index(
  { 'transactions.hash': 1 },
  { unique: true, sparse: true },
);
```

These indexes support:

* escrow-by-delivery lookup;
* escrow status filtering;
* contract-based escrow lookup;
* expiry scans;
* transaction-hash deduplication.

---

### Driver earnings aggregation

The driver earnings implementation is in:

`src/services/driverEarningsService.ts`

The aggregation begins with released escrows and joins deliveries:

```ts
const pipeline: PipelineStage[] = [
  { $match: { status: EscrowStatus.RELEASED } },
  {
    $lookup: {
      from: 'deliveries',
      localField: 'delivery',
      foreignField: '_id',
      as: 'deliveryDoc',
    },
  },
  { $unwind: '$deliveryDoc' },
  {
    $match: {
      'deliveryDoc.driverId': driverId,
    },
  },
  // ...
];
```

The important index relationship is:

```text
Escrow.delivery
      |
      | indexed
      v
Delivery._id
      |
      v
Delivery.driverId
```

Keep the initial `$match` selective.

If the earnings query adds a new filter, verify whether the filter belongs before or after `$lookup` and whether the affected collection has a supporting index.

---

### Event deduplication

Model:

`src/models/EventLog.ts`

The canonical deduplication index is:

```ts
EventLogSchema.index(
  { transactionHash: 1, eventType: 1 },
  { unique: true },
);
```

Additional indexes support:

```ts
EventLogSchema.index({ status: 1, createdAt: 1 });

EventLogSchema.index({ ledgerSequence: 1, eventType: 1 });
```

Do not remove the unique `(transactionHash, eventType)` index.

It prevents the same blockchain event from being persisted more than once.

---

### Webhook retry queue

Model:

`src/models/WebhookDeliveryAttempt.ts`

The retry worker queries:

```ts
{
  status: WebhookDeliveryStatus.FAILED,
  nextRetryAt: { $lte: new Date() },
}
```

The canonical retry index is:

```ts
WebhookDeliveryAttemptSchema.index({
  status: 1,
  nextRetryAt: 1,
});
```

This supports the bounded retry sweep in:

`src/services/webhookService.ts`

The canonical webhook attempt statuses are:

```text
pending
success
failed
exhausted
```

Do not replace the retry query with an unbounded collection scan.

---

### Idempotency keys

Model:

`src/models/IdempotencyRecord.ts`

The canonical uniqueness rule is:

```ts
IdempotencyRecordSchema.index(
  { key: 1, endpoint: 1 },
  { unique: true },
);
```

The TTL cleanup index is:

```ts
IdempotencyRecordSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0 },
);
```

The composite index allows the same key value to be reused safely on different endpoints while preventing duplicates for the same endpoint.

---

### Fleet invitation lookup

Model:

`src/models/FleetInvitation.ts`

Pending invitation uniqueness is enforced with:

```ts
fleetInvitationSchema.index(
  { fleetId: 1, driverId: 1, status: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: FleetInvitationStatus.PENDING,
    },
  },
);

fleetInvitationSchema.index({ driverId: 1 });
```

Do not remove the partial unique index. It permits historical accepted/declined invitations while preventing duplicate pending invitations for the same fleet and driver.

---

## 6. `$lookup` Guidance

Use `$lookup` when the relationship cannot reasonably be represented through an application-level query without creating an N+1 pattern.

The driver earnings aggregation is the reference implementation:

```ts
{
  $lookup: {
    from: 'deliveries',
    localField: 'delivery',
    foreignField: '_id',
    as: 'deliveryDoc',
  },
}
```

### Rules

1. Apply selective `$match` stages as early as practical.
2. Ensure the join fields are indexed.
3. Avoid `$lookup` inside a loop.
4. Avoid retrieving entire joined documents when only a few fields are required.
5. Measure the query plan for hot aggregations.
6. Add or verify supporting indexes before increasing aggregation complexity.

Avoid:

```ts
for (const escrow of escrows) {
  const delivery = await Delivery.findById(escrow.delivery);
}
```

This creates an N+1 query pattern.

Prefer one aggregation or a bounded batch query.

---

## 7. Bulk Insert Semantics

The CSV bulk delivery implementation is:

`src/services/bulkDeliveryService.ts`

It intentionally uses unordered insertion through the repository:

```ts
const inserted = await this.deliveries.createMany(documents, {
  ordered: false,
});
```

The repository ultimately passes the unordered option to the MongoDB/Mongoose bulk insert operation.

### Why `ordered: false` is required

Bulk CSV imports intentionally support partial success.

If one row fails:

```text
Row 1  -> success
Row 2  -> success
Row 3  -> duplicate/error
Row 4  -> success
Row 5  -> success
```

rows 4 and 5 should still be attempted.

`ordered: false` allows MongoDB to continue processing independent documents after an individual write failure.

The service then maps bulk-write errors back to the original CSV line numbers.

Do not change this to ordered insertion unless the business requirement changes to all-or-nothing sequential processing.

---

## 8. Query Plan Verification

The proximity query has a dedicated diagnostic endpoint:

```text
GET /api/v1/drivers/nearby/explain
```

The route is defined in:

`src/routes/driverRoutes.ts`

It is admin-only.

Use it when validating proximity-query index changes.

### Verification procedure

1. Run the application against a representative MongoDB dataset.
2. Call:

```text
GET /api/v1/drivers/nearby/explain
```

3. Inspect the returned query plan.
4. Confirm that MongoDB uses a `2dsphere` index.
5. Confirm that the availability/status compound index is considered for filtered proximity queries.
6. Check that the query is not falling back to a full collection scan.
7. Compare execution statistics before and after index changes.

A healthy plan should show index-backed execution rather than an unbounded collection scan.

### Example query shape

The production proximity model is designed around:

```text
available driver
+
online/on-delivery status filter
+
GeoJSON Point proximity
```

The supporting index is:

```ts
{
  isAvailable: 1,
  status: 1,
  location: '2dsphere',
}
```

Do not add a new proximity index without first checking the existing index and query plan.

---

## 9. Avoiding N+1 Queries

Before merging a query-heavy change, look for:

```ts
for (const item of items) {
  await Model.findOne(...);
}
```

or:

```ts
for (const item of items) {
  await Model.findById(item.id);
}
```

Replace with:

* aggregation;
* `$lookup`;
* `$in` batch queries;
* repository methods that retrieve related records together.

Example:

```ts
const deliveries = await Delivery.find({
  _id: { $in: deliveryIds },
})
  .select('deliveryId driverId status')
  .lean();
```

Then build an in-memory map if necessary:

```ts
const deliveryById = new Map(
  deliveries.map((delivery) => [String(delivery._id), delivery]),
);
```

---

## 10. Full-Collection Scan Rules

Avoid introducing queries that scan an entire collection for an API request.

Potential warning signs include:

```ts
Model.find({})
Model.find().sort(...)
Model.aggregate([{ $sort: ... }])
```

without:

* pagination;
* a selective filter;
* an appropriate index;
* an intentionally bounded administrative operation.

Large administrative sweeps should be explicitly bounded or implemented as jobs.

---

## 11. PR Review Checklist

For every PR that changes a MongoDB query, model, repository, or aggregation:

### Connection

* [ ] Does the change reuse the shared Mongoose connection?
* [ ] Does it avoid creating a new connection per request?
* [ ] Does it avoid unnecessary sessions?

### Reads

* [ ] Is `.lean()` used for read-only queries?
* [ ] Is the projection limited to required fields?
* [ ] Is pagination applied where appropriate?

### Indexes

* [ ] Does the query have an appropriate supporting index?
* [ ] Is an existing hot-query index being removed or changed?
* [ ] Are compound-index field orders compatible with the query?
* [ ] Are TTL indexes preserved?
* [ ] Are sparse/partial unique indexes preserved?

### Aggregations

* [ ] Is `$lookup` necessary?
* [ ] Are join fields indexed?
* [ ] Is there an avoidable N+1 pattern?
* [ ] Are selective `$match` stages placed early?

### Bulk operations

* [ ] Is `ordered: false` preserved where partial success is required?
* [ ] Are bulk errors mapped back to their source records?

### Query plans

* [ ] Has `explain()` been checked for hot queries?
* [ ] Does the plan use the intended index?
* [ ] Is there evidence of an unexpected `COLLSCAN`?
* [ ] Was the query checked against representative data?

### Safety

* [ ] Are user-controlled filters restricted to approved fields/operators?
* [ ] Are sensitive fields excluded from projections?
* [ ] Does the change avoid unbounded collection reads?

---

## 12. Source References

Primary implementation references:

* `src/config/database.ts`
* `src/middlewares/queryMiddleware.ts`
* `src/models/Delivery.ts`
* `src/models/DriverLocation.ts`
* `src/models/Escrow.ts`
* `src/models/EventLog.ts`
* `src/models/FleetInvitation.ts`
* `src/models/IdempotencyRecord.ts`
* `src/models/WebhookDeliveryAttempt.ts`
* `src/services/bulkDeliveryService.ts`
* `src/services/driverEarningsService.ts`
* `src/services/webhookService.ts`
* `src/routes/driverRoutes.ts`
