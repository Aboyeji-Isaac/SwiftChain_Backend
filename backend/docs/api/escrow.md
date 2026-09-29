# Escrow API Reference

This reference documents the escrow, escrow-indexer, admin escrow, and related
Soroban transaction endpoints currently mounted by the API. The API prefix is
`/api/v1` (for example, `POST /api/v1/escrow/fund`). Examples use a local
server at `http://localhost:3000`; replace it with the deployed API origin.

## Response Format

Successful responses use this envelope:

```json
{
  "success": true,
  "data": {},
  "error": null,
  "message": "Operation completed"
}
```

Errors use the same fields, with `success: false`, `data: null`, and a
description in `error` and `message`. Error details can vary by environment;
production responses may hide unexpected internal errors.

Escrow documents serialize their MongoDB `_id` as `id`, omit `__v`, and
include timestamps and the `isFundsLocked` / `isSettled` virtuals.

## Authentication

| Route group                                            | Authentication                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `POST /escrow/fund`                                    | No JWT middleware is applied by the current route. Requires `Idempotency-Key`. |
| Other `/escrow` routes                                 | Bearer JWT required.                                                           |
| `/indexer/escrows` routes                              | No authentication middleware is applied by the current routes.                 |
| `/admin/escrows` routes                                | Bearer JWT and the `admin` role required.                                      |
| `/transactions/escrow-lock` and `/transactions/submit` | No JWT middleware is applied by the current routes.                            |
| Proof-of-delivery upload                               | Bearer JWT; see the ownership-check behavior below.                            |

The public fund and indexer endpoints can mutate or trigger escrow processing.
Restrict access at the network/API gateway if these endpoints are intended only
for trusted indexers or operators. Do not put real credentials in examples or
source control.

For authenticated requests, set:

```bash
export API_ORIGIN="http://localhost:3000"
export TOKEN="<JWT_ACCESS_TOKEN>"
```

## Escrow Lifecycle

| Status     | Meaning and behavior                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------ |
| `pending`  | Model default/pre-lock state. The fund event handler transitions the escrow to `locked`.                                 |
| `locked`   | Funds are held by the Soroban escrow. This is the only status accepted by the release operation.                         |
| `released` | Funds were released. Set by the release operation or a synced `escrow_released` event. Terminal for release.             |
| `refunded` | Funds were refunded. Set by a synced `escrow_refunded` event. Terminal for release.                                      |
| `disputed` | Dispute state; the model treats funds as still held. The escrow release endpoint rejects it because it is not `locked`.  |
| `expired`  | A monitor flags a `locked` escrow whose configured lock TTL elapsed. It cannot be released through the release endpoint. |
| `resolved` | An admin has closed an expired escrow with resolution notes. Terminal.                                                   |

In this checkout, the funded event handler moves records to `locked`, the
release/refund paths move them to `released` or `refunded`, the monitor flags
expired locks, and admin resolution moves `expired` to `resolved`. `disputed`
is a supported model status, but the documented routes and event handlers do
not currently set it. The fund endpoint records an `escrow_funded` event
payload in MongoDB; it does not submit or independently verify a Soroban
transaction. Replaying an already recorded transaction hash is idempotent.

### Release Locking, Conflicts, and Delivery Completion

`releaseEscrow` acquires a Redis Redlock resource named
`escrow:release:<escrowId>` before reading or changing the escrow. The lock is
released in a `finally` block. This prevents concurrent release requests for
the same identifier from processing at the same time. If lock acquisition
fails, the current service surfaces an internal error (normally HTTP 500); it
does not translate lock contention to HTTP 409.

The release operation requires an escrow in `locked` status and a persisted
proof-of-delivery record. A repeated request with a transaction hash already
recorded is an idempotent success. A different transaction hash after release,
or any non-`locked` status, produces HTTP 409. After recording the release
transaction, the service sets the escrow to `released` and the associated
delivery to `completed`.

Proof of delivery does not itself release funds or complete the delivery. Both
the service-level delivery transition to `completed` and escrow release assert
proof independently; the release operation also marks the delivery completed
after it records the escrow release. Missing proof returns HTTP 422.

### Idempotency and HTTP 409

`POST /api/v1/escrow/fund` requires a non-empty `Idempotency-Key` header with a
maximum length of 128 characters. UUID v4 is recommended but not enforced. The
key is scoped to the HTTP method and endpoint path.

- Missing, blank, or oversized keys return HTTP 422.
- If the same key is already processing, the request returns HTTP 409. Wait
  for the original request to finish before retrying.
- Completed or failed requests with the same key replay their cached response;
  the response includes `Idempotency-Key-Status` and
  `Idempotency-Key-Replay: true` headers.
- Replaying the same on-chain `transactionHash` is also a no-op, even with a
  different idempotency key.

HTTP 409 is also used when a release is no longer permitted by the escrow's
status, or when an admin tries to resolve an escrow that is not `expired`.
Those state conflicts require fetching the latest state; changing the request
key does not make an invalid state transition valid.

## Escrow Endpoints

### Record a Funded Escrow

`POST /api/v1/escrow/fund`

**Authentication:** No JWT middleware is applied by the current route.
**Required header:** `Idempotency-Key`.

Request body:

```json
{
  "deliveryId": "<DELIVERY_MONGODB_OBJECT_ID>",
  "contractId": "<SOROBAN_CONTRACT_ID>",
  "transactionHash": "<STELLAR_TRANSACTION_HASH>",
  "amount": 125.5,
  "asset": "XLM",
  "fundedBy": "<PAYER_STELLAR_ADDRESS>",
  "ledger": 123456
}
```

`deliveryId`, `contractId`, `transactionHash`, `amount`, and `asset` are
required. `fundedBy` and `ledger` are optional. Amount must be positive; ledger
must be a non-negative integer. On success, the escrow is stored as `locked`
and the delivery is set to `funded`.

**Responses:** `201` created/recorded; `400` invalid body or database
validation; `404` delivery not found; `409` same idempotency key still
processing; `422` missing/invalid idempotency key; `500` unexpected failure.

```bash
curl -i -X POST "$API_ORIGIN/api/v1/escrow/fund" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 8fdc7d02-e3e8-4a1d-8453-3a76e00a450b' \
  -d '{
    "deliveryId":"<DELIVERY_MONGODB_OBJECT_ID>",
    "contractId":"<SOROBAN_CONTRACT_ID>",
    "transactionHash":"<STELLAR_TRANSACTION_HASH>",
    "amount":125.5,
    "asset":"XLM",
    "fundedBy":"<PAYER_STELLAR_ADDRESS>",
    "ledger":123456
  }'
```

### Get Escrow by Delivery

`GET /api/v1/escrow/delivery/:deliveryId`

**Authentication:** Bearer JWT. `deliveryId` must be a MongoDB ObjectId in the
current service implementation.

**Responses:** `200` escrow found; `400` invalid ObjectId; `401` missing or
invalid JWT; `403` account suspended/banned; `404` escrow not found for
delivery; `500` unexpected failure.

```bash
curl -i "$API_ORIGIN/api/v1/escrow/delivery/<DELIVERY_MONGODB_OBJECT_ID>" \
  -H "Authorization: Bearer $TOKEN"
```

### Get Escrow by Contract

`GET /api/v1/escrow/contract/:contractId`

**Authentication:** Bearer JWT.

**Responses:** `200` escrow found; `401` missing or invalid JWT; `403` account
suspended/banned; `404` escrow not found for contract; `500` unexpected
failure.

```bash
curl -i "$API_ORIGIN/api/v1/escrow/contract/<SOROBAN_CONTRACT_ID>" \
  -H "Authorization: Bearer $TOKEN"
```

### Sync Funded Events

`POST /api/v1/escrow/sync`

**Authentication:** Bearer JWT. Polls Soroban for `escrow_funded` events from
`startLedger` (inclusive). If `contractId` is omitted, the configured
`ESCROW_CONTRACT_ID` is used. Save the returned cursor if resuming a poll.

Request body:

```json
{
  "startLedger": 123456,
  "contractId": "<SOROBAN_CONTRACT_ID>"
}
```

**Responses:** `200` sync summary (`latestLedger`, `cursor`, `processed`,
`ignored`, and per-event results); `400` `startLedger` is not a non-negative
integer; `401` missing or invalid JWT; `403` account suspended/banned; `500`
unexpected/RPC failure or missing contract configuration. Malformed event
payloads are counted as ignored instead of terminating the whole batch.

```bash
curl -i -X POST "$API_ORIGIN/api/v1/escrow/sync" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"startLedger":123456,"contractId":"<SOROBAN_CONTRACT_ID>"}'
```

### Release an Escrow

`POST /api/v1/escrow/release`

**Authentication:** Bearer JWT. This endpoint records a completed on-chain
release in MongoDB; it does not submit a release transaction to Soroban. Call
it only after the on-chain release succeeds, using its transaction hash.

Request body:

```json
{
  "escrowId": "<ESCROW_MONGODB_OBJECT_ID_OR_CONTRACT_ID>",
  "transactionHash": "<CONFIRMED_RELEASE_TRANSACTION_HASH>",
  "ledger": 123789
}
```

`escrowId` and `transactionHash` are required. `escrowId` accepts a MongoDB
ObjectId or a contract id beginning with `C`; `ledger` is optional and must be
a non-negative integer when supplied.

**Responses:** `200` release recorded (or same-transaction replay); `400`
missing/invalid fields or identifier; `401` missing or invalid JWT; `403`
account suspended/banned; `404` escrow not found; `409` escrow is already
released by a different transaction or is not `locked`; `422` proof of
delivery missing; `500` unexpected failure or Redlock acquisition failure.

```bash
curl -i -X POST "$API_ORIGIN/api/v1/escrow/release" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "escrowId":"<ESCROW_MONGODB_OBJECT_ID_OR_CONTRACT_ID>",
    "transactionHash":"<CONFIRMED_RELEASE_TRANSACTION_HASH>",
    "ledger":123789
  }'
```

## Indexer Endpoints

The routes below currently have no authentication middleware. Restrict them to
trusted operators/indexer infrastructure at the network or gateway layer.

### Get Escrow Indexer State

`GET /api/v1/indexer/escrows/:escrowId`

`escrowId` can be a MongoDB ObjectId or Soroban contract id. The response is
read from MongoDB; this endpoint does not query Soroban live.

**Responses:** `200` escrow document; `404` no matching escrow; `500`
unexpected database failure.

```bash
curl -i "$API_ORIGIN/api/v1/indexer/escrows/<ESCROW_MONGODB_OBJECT_ID_OR_CONTRACT_ID>"
```

### Sync Released Events

`POST /api/v1/indexer/escrows/sync/released`

Request body:

```json
{
  "startLedger": 123456,
  "contractId": "<SOROBAN_CONTRACT_ID>"
}
```

`startLedger` is required and must be a non-negative integer. `contractId` is
optional and defaults to `ESCROW_CONTRACT_ID`. Each recognized event updates
escrow status and transaction history idempotently; already-terminal records
are ignored.

**Responses:** `200` sync summary; `400` invalid `startLedger` or `contractId`;
`500` unexpected/RPC failure or missing contract configuration.

```bash
curl -i -X POST "$API_ORIGIN/api/v1/indexer/escrows/sync/released" \
  -H 'Content-Type: application/json' \
  -d '{"startLedger":123456,"contractId":"<SOROBAN_CONTRACT_ID>"}'
```

### Sync Refunded Events

`POST /api/v1/indexer/escrows/sync/refunded`

Request body, response fields, and validation match the released-event sync;
this route polls `escrow_refunded` events and marks eligible records `refunded`.

**Responses:** `200` sync summary; `400` invalid `startLedger` or `contractId`;
`500` unexpected/RPC failure or missing contract configuration.

```bash
curl -i -X POST "$API_ORIGIN/api/v1/indexer/escrows/sync/refunded" \
  -H 'Content-Type: application/json' \
  -d '{"startLedger":123456,"contractId":"<SOROBAN_CONTRACT_ID>"}'
```

## Admin Escrow Endpoints

Both admin routes require a valid bearer JWT and the `admin` role.

### List Expired Escrows

`GET /api/v1/admin/escrows/flagged?page=1&limit=20`

Returns expired escrows for review. `page` defaults to 1; `limit` defaults to
20 and is capped at 100.

**Responses:** `200` paginated results; `400` non-positive/non-integer `page`
or `limit`; `401` missing or invalid JWT; `403` non-admin or suspended/banned
account; `500` unexpected failure.

```bash
curl -i "$API_ORIGIN/api/v1/admin/escrows/flagged?page=1&limit=20" \
  -H "Authorization: Bearer $TOKEN"
```

### Resolve an Expired Escrow

`PATCH /api/v1/admin/escrows/:id/resolve`

Request body:

```json
{
  "notes": "Reviewed and resolved according to the support decision."
}
```

The escrow id must be a MongoDB ObjectId and the escrow must currently be
`expired`. The administrator id, resolution time, and notes are stored for the
audit trail.

**Responses:** `200` resolved; `400` invalid id or missing/blank notes; `401`
missing or invalid JWT; `403` non-admin or suspended/banned account; `404`
escrow not found; `409` escrow is not `expired`; `500` unexpected failure.

```bash
curl -i -X PATCH "$API_ORIGIN/api/v1/admin/escrows/<ESCROW_MONGODB_OBJECT_ID>/resolve" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"notes":"Reviewed and resolved according to the support decision."}'
```

## Soroban Escrow-Lock Transaction Endpoints

These public transaction endpoints prepare and submit the funding/lock
transaction. The backend does not hold or use the payer's secret key; the
client wallet signs the prepared XDR.

### Build an Unsigned Escrow-Lock Transaction

`POST /api/v1/transactions/escrow-lock`

Request body:

```json
{
  "deliveryId": "<DELIVERY_MONGODB_OBJECT_ID>",
  "payerAddress": "<PAYER_STELLAR_PUBLIC_KEY>"
}
```

The amount and contract arguments are resolved server-side from the delivery
in MongoDB and deployment configuration.

**Responses:** `200` simulation-prepared XDR; `400` invalid body; `404` unknown
delivery or payer account; `409` delivery already completed/cancelled; `422`
no usable escrow amount; `502` RPC/simulation failure; `503` escrow contract
not configured; `500` unexpected failure.

```bash
curl -i -X POST "$API_ORIGIN/api/v1/transactions/escrow-lock" \
  -H 'Content-Type: application/json' \
  -d '{"deliveryId":"<DELIVERY_MONGODB_OBJECT_ID>","payerAddress":"<PAYER_STELLAR_PUBLIC_KEY>"}'
```

### Submit a Signed Escrow-Lock Transaction

`POST /api/v1/transactions/submit`

Request body:

```json
{
  "deliveryId": "<DELIVERY_MONGODB_OBJECT_ID>",
  "payerAddress": "<PAYER_STELLAR_PUBLIC_KEY>",
  "signedXdr": "<BASE64_SIGNED_TRANSACTION_ENVELOPE>"
}
```

For `tx_bad_seq`, the service refreshes the account sequence from Soroban RPC
and rebuilds the lock transaction using current database/configuration state.
Retries are bounded by `STELLAR_BAD_SEQ_MAX_RETRIES` (default 3). Exhaustion
returns HTTP 409; other RPC submission failures return HTTP 502. This is the
escrow-lock transaction flow, not the bookkeeping behavior of
`POST /api/v1/escrow/release`.

**Responses:** `200` confirmed; `400` invalid request/XDR; `404` delivery or
payer account not found; `409` sequence mismatch retries exhausted; `502`
RPC rejection/failure; `503` contract not configured; `504` confirmation timed
out; `500` unexpected failure.

```bash
curl -i -X POST "$API_ORIGIN/api/v1/transactions/submit" \
  -H 'Content-Type: application/json' \
  -d '{
    "deliveryId":"<DELIVERY_MONGODB_OBJECT_ID>",
    "payerAddress":"<PAYER_STELLAR_PUBLIC_KEY>",
    "signedXdr":"<BASE64_SIGNED_TRANSACTION_ENVELOPE>"
  }'
```

## Proof-of-Delivery Prerequisite

Upload proof before calling escrow release:

`POST /api/v1/deliveries/:id/proof-of-delivery`

The uploader must authenticate and upload an accepted image as multipart field
`file`. If the delivery has an assigned `driverId`, the current service only
allows that user's id; it does not implement an explicit admin bypass. If no
driver is assigned, any authenticated user passes this ownership check. The
route returns `201` with `{ "delivery": ... }` inside `data`; it does not
itself release escrow or complete the delivery.

```bash
curl -i -X POST "$API_ORIGIN/api/v1/deliveries/<DELIVERY_MONGODB_OBJECT_ID>/proof-of-delivery" \
  -H "Authorization: Bearer $TOKEN" \
  -F 'file=@./proof-of-delivery.jpg'
```

The delivery-status API is a separate workflow. The release service performs
its own proof check and updates the related delivery to `completed` after a
successful release; setting a delivery status alone does not release escrow.

## Runtime Configuration

Use real environment values from the repository's `.env.example` for the
database, Redis lock service, Soroban RPC, network passphrase, and escrow
contract configuration. In particular, event sync defaults to
`ESCROW_CONTRACT_ID`. Keep secrets out of source control and never use example
placeholders as live credentials.
