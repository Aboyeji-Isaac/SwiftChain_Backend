# Webhooks Guide & API Specification

SwiftChain provides real-time HTTP callback notifications to merchants for delivery lifecycle events.

---

## 1. Overview & Architecture

When a delivery transitions between lifecycle states (e.g., `in_progress`, `completed`), SwiftChain automatically delivers an HTTP `POST` webhook to all active subscriber URLs registered by the owning merchant.

Dispatches are executed asynchronously without blocking database transactions. Each dispatch attempt is persisted to the `WebhookDeliveryAttempt` database collection, ensuring durability across service restarts.

---

## 2. Payload Schema Versioning

All webhook payloads (both single-event and batched) include a top-level `schemaVersion` field.

- **Current Version:** `"1.0"`
- Payloads are signed via HMAC-SHA256, guaranteeing that the version and data payload cannot be altered in transit.

### Backwards-Compatibility Rules

1. **Additive Changes:** New fields added within the same major version (e.g. `1.1`) are backward-compatible. Subscribers should ignore unrecognized fields.
2. **Schema Versioning:** The `schemaVersion` field allows merchants to handle schema evolution predictably.
3. **Field Deprecation:** Any field marked for deprecation will remain populated for a minimum of one release cycle.

### Payload Migration Table

| Version            | Status      | Key Changes                                                                                                             | Breaking                 |
| :----------------- | :---------- | :---------------------------------------------------------------------------------------------------------------------- | :----------------------- |
| **`1.0`**          | **Current** | Added `schemaVersion` top-level attribute. Added `allowBatch` subscription flag and `delivery.batch` aggregated events. | No (backward-compatible) |
| **`0.9` (legacy)** | Deprecated  | Unversioned payload format without `schemaVersion`.                                                                     | Legacy                   |

---

## 3. Event Batching (`allowBatch`)

High-volume merchants can reduce HTTP overhead by enabling event batching. When enabled, SwiftChain aggregates events occurring within a configurable flush window into a single HTTP request carrying the `delivery.batch` event.

### Configuration

- **Subscription Flag:** Set `allowBatch: true` when creating or updating a webhook subscription via `POST /api/v1/webhooks` or `PATCH /api/v1/webhooks/:id`.
- **Flush Window:** Controlled by the `WEBHOOK_BATCH_FLUSH_WINDOW_MS` environment variable (default: `1000` ms). Events within this window are grouped per merchant endpoint.
- **Durability:** Even when delivered in batches, every event maintains an individual `WebhookDeliveryAttempt` record in MongoDB, preserving per-event auditability and retry tracking.

---

## 4. Payload Formats

### Single-Event Payload (`schemaVersion: "1.0"`)

Delivered when `allowBatch` is `false` (default):

```json
{
  "event": "delivery.in_progress",
  "schemaVersion": "1.0",
  "timestamp": "2026-10-22T10:00:00.000Z",
  "data": {
    "deliveryId": "653b8f1d8c9a3b001f3e7a1b",
    "trackingNumber": "TRK-9876543210",
    "status": "in_progress",
    "driverId": "653b8f1d8c9a3b001f3e7a99"
  }
}
```

### Batched Event Payload (`delivery.batch`)

Delivered when `allowBatch` is `true`:

```json
{
  "event": "delivery.batch",
  "schemaVersion": "1.0",
  "timestamp": "2026-10-22T10:00:01.000Z",
  "data": {
    "batchSize": 2,
    "events": [
      {
        "event": "delivery.in_progress",
        "schemaVersion": "1.0",
        "timestamp": "2026-10-22T10:00:00.000Z",
        "data": {
          "deliveryId": "653b8f1d8c9a3b001f3e7a1b",
          "trackingNumber": "TRK-9876543210",
          "status": "in_progress",
          "driverId": "653b8f1d8c9a3b001f3e7a99"
        }
      },
      {
        "event": "delivery.completed",
        "schemaVersion": "1.0",
        "timestamp": "2026-10-22T10:00:01.000Z",
        "data": {
          "deliveryId": "653b8f1d8c9a3b001f3e7a1c",
          "trackingNumber": "TRK-9876543211",
          "status": "completed",
          "driverId": "653b8f1d8c9a3b001f3e7a99"
        }
      }
    ]
  }
}
```

---

## 5. HTTP Headers & Verification

Every webhook request contains the following HTTP headers:

| Header                     | Description                                                |
| :------------------------- | :--------------------------------------------------------- |
| `Content-Type`             | `application/json`                                         |
| `X-SwiftChain-Event`       | Event name (e.g. `delivery.completed` or `delivery.batch`) |
| `X-SwiftChain-Signature`   | HMAC-SHA256 signature in the format `sha256=<hex>`         |
| `X-SwiftChain-Timestamp`   | ISO 8601 timestamp of dispatch                             |
| `X-SwiftChain-Batch-Size`  | _(Batched only)_ Number of aggregated events in the batch  |
| `X-SwiftChain-Delivery-Id` | _(Single only)_ MongoDB ObjectId of the delivery           |
| `X-SwiftChain-Attempt-Id`  | _(Single only)_ MongoDB ObjectId of the delivery attempt   |

### Signature Verification Example (Node.js)

```typescript
import crypto from 'crypto';

function verifySwiftChainWebhook(
  rawBody: string,
  signatureHeader: string,
  secret: string,
): boolean {
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const expected = Buffer.from(`sha256=${digest}`);
  const actual = Buffer.from(signatureHeader);

  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}
```

---

## 6. Endpoints

- `POST /api/v1/webhooks` — Register webhook endpoint (accepts `allowBatch?: boolean`).
- `GET /api/v1/webhooks` — List merchant's registered webhooks.
- `GET /api/v1/webhooks/:id` — Retrieve webhook subscription.
- `PATCH /api/v1/webhooks/:id` — Update subscription URL, events, active state, or `allowBatch`.
- `DELETE /api/v1/webhooks/:id` — Delete webhook registration.
- `POST /api/v1/webhooks/:id/rotate-secret` — Rotate signing secret.
