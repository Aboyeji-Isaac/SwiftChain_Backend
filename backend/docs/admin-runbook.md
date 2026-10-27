# SwiftChain Backend Admin Operations Runbook

## Scope

This runbook covers administrator-only operations for:

* user suspension and banning
* dispute monitoring
* dead-letter queue inspection and retry
* expired escrow review
* dashboard metrics
* audit logging

Admin routes are defined in:

```text
src/routes/adminRoutes.ts
```

All routes are protected by:

```text
authenticate
requireRole(UserRole.ADMIN)
```

Therefore requests require a valid JWT and the `admin` role.

## Authentication

Send the administrator's JWT using:

```http
Authorization: Bearer <JWT>
```

Unauthenticated requests receive `401`.

Authenticated users without the required administrator role receive `403`.

## Admin Dashboard

### `GET /api/v1/admin/dashboard`

Returns aggregated operational metrics.

### Query parameters

```text
refresh=true
```

or:

```text
refresh=1
```

forces a fresh aggregation instead of using the Redis cache.

### Response data

The dashboard aggregates:

* active deliveries
* delivery counts by active status
* active driver count
* recently active drivers
* escrow volume
* locked escrow
* released escrow
* refunded escrow
* active escrow count
* total escrow count
* Soroban RPC connectivity
* latest ledger
* configured network
* cache metadata

Example:

```json
{
  "status": "success",
  "data": {
    "activeDeliveries": {
      "total": 12,
      "byStatus": {
        "pending": 3,
        "funded": 2,
        "assigned": 4,
        "in_progress": 3
      }
    },
    "onlineDrivers": {
      "totalActiveDrivers": 25,
      "recentlyActiveDrivers": 18
    },
    "escrow": {
      "totalVolume": 1000,
      "lockedVolume": 400,
      "releasedVolume": 500,
      "refundedVolume": 100,
      "activeCount": 6,
      "totalCount": 20
    },
    "metadata": {
      "cached": false,
      "cacheTtlSeconds": 60
    }
  }
}
```

## Dashboard Caching

Dashboard metrics use the Redis key:

```text
admin:dashboard:metrics
```

The TTL is configured with:

```env
ADMIN_DASHBOARD_CACHE_TTL_SECONDS=60
```

If the value is missing or invalid, the service falls back to `60` seconds.

A normal request:

```http
GET /api/v1/admin/dashboard
```

reads cached metrics when available.

To force fresh aggregation:

```http
GET /api/v1/admin/dashboard?refresh=true
```

Fresh metrics are calculated from MongoDB and Soroban connectivity, then written back to Redis.

## User Suspension and Ban

### `PUT /api/v1/admin/users/:id/suspend`

Suspends a user or permanently bans the account when `ban: true`.

### Request

```json
{
  "reason": "Repeated delivery policy violations",
  "ban": false
}
```

For a permanent ban:

```json
{
  "reason": "Confirmed fraudulent activity",
  "ban": true
}
```

### Validation

`reason` is mandatory and must be a non-empty string.

`ban`, when supplied, must be a boolean.

Missing or invalid reason:

```text
400 Bad Request
```

### Operational behavior

The service:

1. Authenticates the requesting administrator.
2. Validates the target user ID.
3. Prevents an administrator from acting on their own account.
4. Prevents an administrator from suspending or banning another administrator.
5. Validates the target's current state.
6. Updates the account status.
7. Records the reason.
8. Creates an audit-log entry.
9. Returns the updated user.

The returned action is either:

```text
suspended
```

or:

```text
banned
```

### Operational guidance

Always provide a specific, human-readable reason.

Example:

```text
Repeated cancellation abuse after previous warnings.
```

Avoid vague reasons such as:

```text
bad user
```

The reason becomes part of the administrative audit trail.

## Dispute Operations

### `GET /api/v1/admin/disputes`

Returns a paginated list of disputes.

### Query parameters

```text
page=1
limit=10
status=open
```

Supported status filters include:

```text
open
under_review
resolved
rejected
active
all
```

### Example

```http
GET /api/v1/admin/disputes?page=1&limit=20&status=open
```

The response contains:

* dispute records
* current page
* page size
* total records
* total pages

### Dispute lifecycle

The database model defines:

```text
open
  ↓
under_review
  ↓
resolved
```

or:

```text
under_review
  ↓
rejected
```

Disputes can also be populated from Soroban indexer events.

An on-chain `dispute_opened` event is persisted using the on-chain `disputeId`.

An on-chain `dispute_resolved` event records:

* resolution
* resolved ledger
* resolution timestamp

### Escrow relationship

Escrow uses the `disputed` state when funds remain held while a dispute is active.

The escrow model treats:

```text
locked
disputed
```

as funds-held states.

Terminal escrow states include:

```text
released
refunded
resolved
```

Therefore administrators should verify the corresponding escrow record before treating a dispute as financially settled.

## Dead-Letter Queue

### `GET /api/v1/admin/dlq`

Returns failed transaction entries.

### Query parameters

```text
page=1
limit=10
```

Entries are sorted newest-first.

### Example

```http
GET /api/v1/admin/dlq?page=1&limit=20
```

The response contains:

* DLQ entries
* total count
* page
* limit
* total pages

## Retry a DLQ Entry

### `POST /api/v1/admin/dlq/:id/retry`

Retries a specific failed entry.

The service:

1. Loads the DLQ record.
2. Rejects a missing entry with `404`.
3. Rejects already resolved entries with `400`.
4. Increments `retryCount`.
5. Changes the state to `retried`.
6. Replays the stored payload through `stellarService.submitEscrowLock`.
7. Marks the entry `resolved` when successful.
8. Returns it to `pending` when the retry fails.
9. Stores the new error reason.

### Successful retry

```text
pending
  ↓
retried
  ↓
resolved
```

### Failed retry

```text
pending
  ↓
retried
  ↓
pending
```

A failed retry does not permanently consume the DLQ entry. It remains eligible for another manual retry.

### Retry exhaustion

The current `DlqEntry` model does not define a terminal `exhausted` status or a maximum retry counter.

Therefore the current implementation does **not** automatically mark a DLQ entry as exhausted.

Operational tooling should treat unusually high `retryCount` values as a manual investigation signal rather than assuming automatic exhaustion behavior exists.

## Expired Escrow Review

### `GET /api/v1/admin/escrows/flagged`

Returns escrows whose lock TTL has expired and that require administrator review.

Optional parameters:

```text
page=1
limit=20
```

Maximum page size is documented by the route as `100`.

### `PATCH /api/v1/admin/escrows/:id/resolve`

Resolves a flagged escrow.

Request body:

```json
{
  "notes": "Reviewed transaction history and completed manual settlement."
}
```

`notes` is required.

Resolution records the administrator and resolution note in the escrow audit fields.

Do not resolve an escrow without confirming the associated delivery, dispute state, on-chain transaction history and financial outcome.

## Audit Logging

Administrative actions are recorded by the `AuditLog` model:

```text
src/models/AuditLog.ts
```

Recorded information includes:

* action
* actor
* target type
* target ID
* description
* metadata
* creation timestamp

For suspension/ban operations, the reason should always be supplied so the resulting audit record explains why the action occurred.

## Common Errors

| Status | Meaning                        | Operator action                              |
| ------ | ------------------------------ | -------------------------------------------- |
| `400`  | Invalid request or query       | Correct request parameters                   |
| `401`  | Authentication missing/invalid | Obtain a valid administrator JWT             |
| `403`  | Insufficient privileges        | Verify administrator role                    |
| `404`  | Resource does not exist        | Verify the user, dispute, DLQ or escrow ID   |
| `409`  | State conflict                 | Inspect current resource state               |
| `422`  | Invalid administrative action  | Review target and account constraints        |
| `500`  | Internal operation failure     | Check application logs and dependency health |

## Admin Safety Checklist

Before a destructive or financially relevant operation:

* [ ] Confirm the target ID.
* [ ] Confirm the current resource status.
* [ ] Confirm the administrator identity.
* [ ] Provide a specific audit reason/notes.
* [ ] Check related delivery/dispute/escrow records.
* [ ] Check `/api/v1/health`.
* [ ] Check `/api/v1/health/circuit-breakers` when blockchain operations are involved.
* [ ] Review application logs after retry or resolution.
