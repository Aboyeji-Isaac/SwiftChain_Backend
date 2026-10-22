# Idempotency-Key Integrator Specification

## Overview

The escrow funding endpoint requires an `Idempotency-Key` header:

```http
POST /api/v1/escrow/fund
```

Idempotency prevents a client retry from executing the same logical operation multiple times.

A UUID v4 is recommended.

```http
Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000
```

Use **one key per logical operation**.

---

# Header Contract

## Required Header

```http
Idempotency-Key: <unique-key>
```

The backend accepts a key up to `128` characters.

Blank keys and missing keys are rejected.

### Recommended Format

UUID v4:

```text
550e8400-e29b-41d4-a716-446655440000
```

The backend does not require the value itself to match a UUID regex, but UUID v4 is the recommended client format.

---

# Key Scope

The effective idempotency namespace is:

```text
HTTP method + base URL + request path + Idempotency-Key
```

For example:

```text
POST:/api/v1/escrow/fund:550e8400-e29b-41d4-a716-446655440000
```

The same key may therefore be used on different endpoints without sharing the stored response.

Clients should nevertheless generate a fresh key for every logical operation.

A key must not be reused for a different logical operation or different payload on the same endpoint.

The idempotency layer itself namespaces records by:

```text
key + endpoint
```

---

# Protected Endpoint

```http
POST /api/v1/escrow/fund
```

The route is mounted behind authentication and the idempotency middleware.

### Example

```bash
curl -X POST \
  "http://localhost:3000/api/v1/escrow/fund" \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000" \
  -d '{
    "deliveryId": "65f000000000000000000001",
    "transactionHash": "abc123..."
  }'
```

The request body must additionally satisfy the escrow funding validator.

---

# Response Semantics

| Situation                               |                   Status | Behavior                                          |
| --------------------------------------- | -----------------------: | ------------------------------------------------- |
| Missing `Idempotency-Key`               |                    `422` | Request rejected                                  |
| Blank key                               |                    `422` | Request rejected                                  |
| Key longer than 128 chars               |                    `422` | Request rejected                                  |
| First request                           |              `2xx`/`4xx` | Operation executes                                |
| Concurrent request using processing key |                    `409` | Original request remains authoritative            |
| Completed key replay                    |          Original status | Stored response is replayed                       |
| Failed key replay                       |    Original error status | Stored failure response is replayed               |
| Expired key                             | Depends on new execution | Operation can execute as a new idempotency record |

---

# 422 — Missing or Invalid Key

### Example

```bash
curl -X POST \
  "http://localhost:3000/api/v1/escrow/fund" \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{
    "deliveryId": "65f000000000000000000001"
  }'
```

The middleware returns `422 Unprocessable Entity` because the required header is absent.

The same status is used for a blank key or a key exceeding 128 characters.

---

# 409 — Concurrent Request

When a request with the same key is already being processed, the duplicate does not execute the escrow handler again.

The response is:

```http
409 Conflict
Idempotency-Key-Status: processing
```

Example error:

```json
{
  "success": false,
  "data": null,
  "error": "A request with this Idempotency-Key is already being processed. Please wait for the original request to complete, then retry if needed.",
  "message": "A request with this Idempotency-Key is already being processed. Please wait for the original request to complete, then retry if needed."
}
```

---

# Completed Request Replay

After the first request completes, its HTTP status and JSON response body are stored.

A subsequent request using the same key and endpoint does not execute the handler again.

The middleware returns the stored response and sets:

```http
Idempotency-Key-Status: completed
Idempotency-Key-Replay: true
```

### Example

```bash
curl -X POST \
  "http://localhost:3000/api/v1/escrow/fund" \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000" \
  -d '{
    "deliveryId": "65f000000000000000000001",
    "transactionHash": "abc123..."
  }'
```

The second request receives the previously stored response.

---

# Failed Request Replay

Non-2xx responses are stored with:

```text
status = failed
```

A duplicate request before the record expires receives the stored error response instead of executing the operation again.

This prevents repeated retries from repeatedly executing the same application-level operation after a recorded failure.

---

# Safe Retry Rules

## Network Failure Before Receiving a Response

Reuse the **same** `Idempotency-Key`.

```text
Request A
  |
  +--> server processes request
  |
  +--> network failure before client receives response
  |
  +--> retry using SAME Idempotency-Key
```

The server can replay the stored result if the original request completed.

## Known Completed Operation

Do not create a new key when retrying because of an uncertain client-side response.

Reuse the same key to retrieve the original result.

## New Logical Operation

Generate a new key.

```text
Operation A -> key-A
Operation B -> key-B
```

Never reuse a completed key for an unrelated escrow funding operation.

---

# TTL and Expiry

The default configuration is:

```text
IDEMPOTENCY_TTL_SECONDS = 86400
```

That is 24 hours unless overridden by environment configuration.

The value must be at least 60 seconds.

## Redis

When Redis is available, idempotency records use Redis TTL expiration.

Redis keys use the namespace:

```text
idempotency:<endpoint>:<key>
```

## MongoDB Fallback

MongoDB stores:

```text
key
endpoint
status
responseStatus
responseBody
expiresAt
```

A TTL index on `expiresAt` automatically removes expired records.

---

# Retry After Expiry

Once an idempotency record expires, the key is no longer associated with the previous stored result.

A subsequent request using that key is therefore treated as a new request.

For this reason, clients should not intentionally reuse an old key after its expected retention period.

For a genuinely new logical operation, always generate a new key.

---

# Transaction-Level Protection

Escrow funding also contains transaction-level idempotency through the recorded transaction hash.

The escrow route documentation describes this as a separate protection from the HTTP `Idempotency-Key`.

Therefore:

```text
HTTP retry protection
        +
transaction-level duplicate protection
```

provide two independent safeguards against duplicate escrow funding records.

---

# Integration Pattern

Recommended client flow:

```text
1. Generate UUID v4.
2. Associate it with one logical escrow-funding operation.
3. Send Idempotency-Key with the request.
4. If the network fails, retry with the SAME key.
5. If 409 is returned, wait for the original request to finish.
6. Retry with the SAME key.
7. If the operation is intentionally new, generate a NEW key.
```

Example:

```typescript
const idempotencyKey = crypto.randomUUID();

await fetch('/api/v1/escrow/fund', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Idempotency-Key': idempotencyKey,
  },
  body: JSON.stringify({
    deliveryId,
    transactionHash,
  }),
});
```

---

## Related Implementation

```text
src/middlewares/idempotency.ts
src/services/idempotency.service.ts
src/models/IdempotencyRecord.ts
src/routes/escrow.routes.ts
src/config/env.ts
```
