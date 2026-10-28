# API Versioning and Endpoint Deprecation Policy

## Overview

SwiftChain Backend exposes its REST API through the `/api` prefix. Versioned API routes use the `/v1` prefix:

```text
/api/v1/<resource>
```

The application mounts the versioned router in `src/app.ts`:

```typescript
app.use('/api', routes);
```

The version-specific routes are registered in:

```text
src/routes/index.ts
```

New public REST endpoints **must** be added under `/v1` unless a future major API version is intentionally introduced.

---

## Versioning Convention

### Current API Version

The current public API version is:

```text
v1
```

Examples:

```text
GET  /api/v1/health
GET  /api/v1/deliveries
POST /api/v1/transactions/escrow-lock
POST /api/v1/uploads/evidence
GET  /api/v1/webhooks
```

A new route should follow the existing router pattern.

Example:

```typescript
// src/routes/exampleRoutes.ts

import { Router } from 'express';

const router = Router();

router.get('/', (_req, res) => {
  res.json({
    success: true,
    data: null,
    error: null,
    message: 'Example endpoint',
  });
});

export default router;
```

Then mount it from `src/routes/index.ts`:

```typescript
import exampleRoutes from './exampleRoutes';

router.use('/v1/example', exampleRoutes);
```

The resulting endpoint is:

```text
GET /api/v1/example
```

---

## Route Registration Is the Source of Truth

An endpoint is considered public only when its route file is mounted through:

```text
src/routes/index.ts
```

The current router explicitly mounts:

```typescript
router.use('/v1/auth', authRoutes);
router.use('/v1/deliveries', bulkDeliveryRoutes);
router.use('/v1/deliveries', deliveryCrudRoutes);
router.use('/v1/deliveries', deliveryEtaRoutes);
router.use('/v1/deliveries', deliveryStatusRoutes);
router.use('/v1/deliveries', assignmentRoutes);
router.use('/v1/deliveries', proofOfDeliveryRoutes);
router.use('/v1/admin', adminRoutes);
router.use('/v1/drivers', driverRoutes);
router.use('/v1/fleets', fleetRoutes);
router.use('/v1/disputes', disputeRoutes);
router.use('/v1/eventlog', eventLogRoutes);
router.use('/v1/monitor', monitorRoutes);
router.use('/v1/profile', profileRoutes);
router.use('/v1/notifications', notificationRoutes);
router.use('/v1/health', healthRoutes);
router.use('/v1/socket-metrics', socketMetricsRoutes);
router.use('/v1/users', userRoutes);
router.use('/v1/stellar', stellarRoutes);
router.use('/v1/transactions', transactionRoutes);
router.use('/v1/uploads', uploadRoutes);
router.use('/v1/webhooks', webhookRoutes);
router.use('/v1/escrow', escrowRoutes);
router.use('/v1/indexer', escrowIndexerRoutes);
router.use('/v1/indexer', indexerRoutes);
router.use('/v1/pooling', poolingRoutes);
```

Route files that exist in `src/routes/` but are not mounted must not be documented as public endpoints.

For example, the current `src/routes/transactionRoutes.ts` is mounted and therefore these endpoints are valid:

```text
POST /api/v1/transactions/escrow-lock
POST /api/v1/transactions/submit
```

Likewise, `src/routes/uploadRoutes.ts` is mounted and exposes:

```text
POST /api/v1/uploads/evidence
GET  /api/v1/uploads/evidence/:disputeId
```

---

## Current API Inventory

### Authentication

```text
POST /api/v1/auth/register
POST /api/v1/auth/login
```

### Deliveries

```text
POST  /api/v1/deliveries
GET   /api/v1/deliveries
GET   /api/v1/deliveries/:id
PATCH /api/v1/deliveries/:id
PATCH /api/v1/deliveries/:id/assign-driver
PATCH /api/v1/deliveries/:id/archive
PATCH /api/v1/deliveries/:id/restore
GET   /api/v1/deliveries/:id/qrcode
PUT   /api/v1/deliveries/:id/status
```

### Transactions

```text
POST /api/v1/transactions/escrow-lock
POST /api/v1/transactions/submit
```

### Escrow

```text
GET   /api/v1/escrow/delivery/:id
GET   /api/v1/escrow/contract/:contractId
POST  /api/v1/escrow/fund
POST  /api/v1/escrow/sync
POST  /api/v1/escrow/release
GET   /api/v1/admin/escrows/flagged
PATCH /api/v1/admin/escrows/:id/resolve
```

### Monitoring and Health

```text
GET /api/v1/monitor/indexer-lag
GET /api/v1/monitor/indexer-lag/alerts
GET /api/v1/health
GET /api/v1/health/circuit-breakers
```

### Indexer

```text
GET  /api/v1/indexer/escrows/:escrowId
POST /api/v1/indexer/escrows/sync/released
POST /api/v1/indexer/escrows/sync/refunded
POST /api/v1/indexer/delivery-created
```

### Uploads

```text
POST /api/v1/uploads/evidence
GET  /api/v1/uploads/evidence/:disputeId
```

---

## Deprecation Policy

An endpoint should be deprecated when a replacement endpoint exists but existing consumers still require a migration period.

### Deprecation Stages

1. **Active**

   * Endpoint is supported.
   * New integrations may use it.

2. **Deprecated**

   * Endpoint remains operational.
   * New integrations should use the replacement.
   * Documentation identifies the replacement.
   * Responses should communicate the deprecation.

3. **Removal Scheduled**

   * A removal date/version is documented.
   * Consumers must migrate before removal.

4. **Removed**

   * Route is no longer mounted.
   * Requests return the standard `404` response.

---

## Deprecation Headers

Deprecated routes should return standard HTTP deprecation metadata.

Example:

```typescript
res.setHeader('Deprecation', 'true');
res.setHeader('Sunset', '2027-01-01T00:00:00Z');
res.setHeader('Link', '</api/v1/new-resource>; rel="successor-version"');
```

Where appropriate, the response message should identify the replacement:

```typescript
sendSuccess(
  res,
  data,
  'This endpoint is deprecated. Use /api/v1/new-resource instead.',
);
```

The deprecation date and replacement must be documented before the endpoint is removed.

---

## Removal Rules

A deprecated endpoint should not be removed immediately.

Before removal:

* Mark the endpoint deprecated.
* Document the replacement.
* Add the deprecation response headers.
* Communicate the planned removal date.
* Allow existing clients a migration period.
* Remove the route from its route file.
* Remove its mount from `src/routes/index.ts`.
* Remove obsolete Swagger/OpenAPI documentation.
* Remove tests that only cover the removed route.
* Update `README.md`.

---

## Legacy `deliveries.ts` Status Endpoint

The legacy route file:

```text
src/routes/deliveries.ts
```

currently contains:

```text
PUT /api/v1/deliveries/:id/status
```

It is mounted by:

```typescript
router.use('/v1/deliveries', deliveryStatusRoutes);
```

The route uses:

```typescript
router.put(
  '/:id/status',
  authenticate,
  authorize(['driver', 'admin']),
  updateDeliveryStatus,
);
```

The route documentation describes the transition sequence as:

```text
pending -> assigned -> picked_up -> in_transit -> delivered
```

The broader delivery CRUD documentation contains another status vocabulary:

```text
pending
assigned
in_progress
completed
cancelled
```

These are not interchangeable representations.

Until the status model is formally consolidated, contributors must treat the implementation in `src/controllers/deliveryStatusController.ts` and the associated delivery model/state definitions as authoritative rather than copying status values from unrelated documentation.

---

## README API Section

The README API section should contain only endpoints confirmed through `src/routes/index.ts`.

The API documentation should therefore use:

```markdown
## 📡 API Endpoints

All REST endpoints are exposed under `/api` and versioned under `/api/v1`.

Only routes mounted through `src/routes/index.ts` are considered public API endpoints.

### Health

- `GET /api/v1/health`
- `GET /api/v1/health/circuit-breakers`

### Transactions

- `POST /api/v1/transactions/escrow-lock`
- `POST /api/v1/transactions/submit`

### Uploads

- `POST /api/v1/uploads/evidence`
- `GET /api/v1/uploads/evidence/:disputeId`
```

When adding a new endpoint to the README, verify the corresponding `router.use(...)` registration first.

---

## Contributor Checklist

Before documenting a new endpoint:

* [ ] Route file exists.
* [ ] Route is mounted in `src/routes/index.ts`.
* [ ] Route uses `/v1`.
* [ ] HTTP method is correct.
* [ ] Authentication requirements are documented.
* [ ] Request validation is documented.
* [ ] Response envelope is documented.
* [ ] Swagger/OpenAPI documentation exists.
* [ ] Tests exist.
* [ ] README API inventory is updated.
* [ ] Deprecated routes are explicitly marked.
