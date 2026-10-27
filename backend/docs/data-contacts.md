# Data Contracts and Conventions for Frontend and Mobile Clients

## Purpose

This document is the client-facing source of truth for SwiftChain_Backend data representation.

Clients should follow these conventions when consuming REST responses from the backend.

The most important rules are:

* Monetary blockchain amounts use integer stroops when an endpoint exposes Stellar/Soroban wire amounts.
* Human-readable monetary values use the documented display-unit representation.
* Timestamps are UTC ISO-8601 strings.
* Clients perform timezone conversion for display.
* GeoJSON coordinates are `[longitude, latitude]`.
* `deliveryId` and MongoDB `_id` are different identifiers and must not be treated as interchangeable.
* Delivery, escrow, dispute, fleet invitation, webhook attempt, and indexer states use the canonical enums documented below.
* REST responses use the `{ success, data, error, message }` envelope.
* Paginated endpoints expose pagination metadata according to the endpoint contract.

---

## 1. Response Envelope

The shared response helper is:

`src/utils/responseWrapper.ts`

Successful responses use:

```json
{
  "success": true,
  "data": {},
  "error": null,
  "message": "Operation successful"
}
```

Error responses use:

```json
{
  "success": false,
  "data": null,
  "error": "Delivery not found",
  "message": "Delivery not found"
}
```

### Field contract

| Field     | Type              | Meaning                                      |
| --------- | ----------------- | -------------------------------------------- |
| `success` | boolean           | Whether the operation completed successfully |
| `data`    | object/array/null | Response payload                             |
| `error`   | string/null       | Machine-readable error description           |
| `message` | string            | Human-readable response message              |

Clients should branch primarily on `success` and HTTP status, not on the wording of `message`.

### Success example

```json
{
  "success": true,
  "data": {
    "deliveryId": "DEL-001",
    "status": "pending"
  },
  "error": null,
  "message": "Delivery retrieved successfully"
}
```

### Error example

```json
{
  "success": false,
  "data": null,
  "error": "Delivery not found",
  "message": "Delivery not found"
}
```

---

## 2. Money and Stroops

Stellar uses seven decimal places.

The backend utility:

`src/utils/stroops.ts`

defines:

```ts
export const STELLAR_DECIMALS = 7;
```

Therefore:

```text
1 XLM = 10,000,000 stroops
```

### Wire representation

When an API contract exposes a Stellar/Soroban integer amount, clients must treat it as an integer stroop amount.

Example:

```json
{
  "amount": 1502500000
}
```

represents:

```text
150.2500000 display units
```

### Conversion

The backend uses:

```ts
toStroops(150.25);
// 1502500000n
```

and:

```ts
fromStroops(1502500000n);
// "150.2500000"
```

### Client rule

Do not use binary floating-point arithmetic for stroop values.

Prefer integer arithmetic or a decimal/big-number library on the client.

Avoid:

```ts
const stroops = amount * 10_000_000;
```

when `amount` is represented as a JavaScript floating-point number and exact financial precision matters.

### Display conversion

The client should convert a wire-level stroop integer to display units only at the presentation boundary.

Conceptually:

```text
wire integer
    |
    v
stroops
    |
    | divide by 10^7
    v
display amount
```

### Escrow model distinction

The `Escrow` model stores:

```ts
amount: number;
```

and explicitly documents the value as asset units rather than stroops.

Therefore, clients must follow the individual endpoint contract:

* blockchain transaction/XDR fields may use stroops;
* persisted/API escrow amount fields may use decimal asset units;
* never assume every numeric `amount` field has the same unit without checking its endpoint contract.

---

## 3. Timestamp Convention

All API timestamps should be interpreted as UTC ISO-8601 timestamps.

Examples:

```text
2026-09-30T12:30:00.000Z
```

or:

```text
2026-09-30T12:30:00Z
```

The `Z` suffix indicates UTC.

### Client rule

Timezone conversion belongs on the client.

The backend should not convert persisted timestamps into the user's local timezone before serialization.

Example:

```json
{
  "createdAt": "2026-09-30T12:30:00.000Z",
  "updatedAt": "2026-09-30T13:10:00.000Z"
}
```

A client in Lagos may display these in WAT.

A client in another timezone may display the same instant using that user's configured timezone.

### Do not send local-only timestamps

Avoid sending:

```text
30/09/2026 13:30
```

or:

```text
2026-09-30 13:30
```

when the field represents an absolute point in time.

Prefer:

```text
2026-09-30T12:30:00.000Z
```

---

## 4. GeoJSON Coordinates

MongoDB geospatial fields use GeoJSON.

The canonical GeoJSON coordinate order is:

```text
[longitude, latitude]
```

not:

```text
[latitude, longitude]
```

The `DriverLocation` model defines:

```ts
export interface IGeoPoint {
  type: 'Point';
  coordinates: [number, number];
}
```

The model validation also enforces:

```text
longitude: -180 to 180
latitude:   -90 to 90
```

### Correct example

For:

```text
latitude  = 6.5244
longitude = 3.3792
```

the GeoJSON representation is:

```json
{
  "type": "Point",
  "coordinates": [3.3792, 6.5244]
}
```

### Common bug

Incorrect:

```json
{
  "type": "Point",
  "coordinates": [6.5244, 3.3792]
}
```

The backend's driver-location helper converts API `{ lat, lng }` into GeoJSON order:

```ts
DriverLocation.toGeoPoint(lat, lng);
```

and converts stored GeoJSON back to API order through:

```ts
driverLocation.toLatLng();
```

### Client rule

If the client API contract exposes:

```json
{
  "lat": 6.5244,
  "lng": 3.3792
}
```

keep that representation at the application boundary.

Only use:

```text
[lng, lat]
```

when constructing or consuming GeoJSON.

---

## 5. Delivery Identifiers

SwiftChain has two different delivery identifiers.

### Business identifier

```text
deliveryId
```

This is the application/business identifier.

Example:

```json
{
  "deliveryId": "DEL-2026-000123"
}
```

### MongoDB identifier

```text
_id
```

This is the MongoDB document identifier.

Example:

```json
{
  "_id": "66f2f6..."
}
```

or the transformed API equivalent when an endpoint exposes `id`.

### Do not interchange them

The two values have different purposes.

| Identifier   | Purpose                                  |
| ------------ | ---------------------------------------- |
| `deliveryId` | Business/client-facing delivery identity |
| Mongo `_id`  | Database/document identity               |

For example, the escrow API explicitly supports a delivery lookup using either the delivery `_id` or business `deliveryId`.

Clients should nevertheless use the identifier required by the specific endpoint rather than assuming that either value works everywhere.

---

## 6. Delivery Status Enum

Source:

`src/models/Delivery.ts`

Canonical values:

```text
pending
funded
assigned
in_progress
completed
cancelled
```

TypeScript representation:

```ts
export enum DeliveryStatus {
  PENDING = 'pending',
  FUNDED = 'funded',
  ASSIGNED = 'assigned',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
}
```

### Example

```json
{
  "deliveryId": "DEL-001",
  "status": "in_progress"
}
```

Clients should not invent alternative values such as:

```text
in-progress
inProgress
IN_PROGRESS
```

when communicating with the API.

---

## 7. Escrow Lock Status

Source:

`src/models/Escrow.ts`

Canonical escrow lifecycle values are:

```text
pending
locked
released
refunded
disputed
expired
resolved
```

The backward-compatible `EscrowLockStatus` alias contains:

```text
pending
locked
released
refunded
disputed
```

### Example

```json
{
  "status": "locked",
  "amount": 150.25,
  "assetCode": "XLM"
}
```

Clients should treat the backend enum values as opaque contract values and should not derive new values by string manipulation.

---

## 8. Dispute Status

Source:

`src/models/Dispute.ts`

Canonical values:

```text
open
under_review
resolved
rejected
```

Example:

```json
{
  "deliveryId": "DEL-001",
  "status": "under_review"
}
```

The dispute reason is a separate enum:

```text
damaged_package
late_delivery
wrong_item
non_delivery
other
```

Do not use the dispute reason as the dispute lifecycle state.

---

## 9. Fleet Invitation Status

Source:

`src/interfaces/IFleet.ts`

Canonical values:

```text
pending
accepted
declined
```

Example:

```json
{
  "fleetId": "66f...",
  "driverId": "66a...",
  "status": "pending"
}
```

A pending invitation is additionally protected by a partial unique MongoDB index so that a fleet and driver cannot have two simultaneous pending invitations.

---

## 10. Webhook Delivery Attempt Status

Source:

`src/models/WebhookDeliveryAttempt.ts`

Canonical values:

```text
pending
success
failed
exhausted
```

Meaning:

| Status      | Meaning                                                                          |
| ----------- | -------------------------------------------------------------------------------- |
| `pending`   | Attempt exists but has not completed successfully                                |
| `success`   | Delivery succeeded                                                               |
| `failed`    | Delivery failed and is eligible for retry                                        |
| `exhausted` | Maximum retry attempts have been reached or the subscription is no longer usable |

Example:

```json
{
  "status": "failed",
  "attempts": 2,
  "maxAttempts": 5,
  "nextRetryAt": "2026-09-30T13:35:00.000Z"
}
```

Clients should not interpret `failed` as permanently failed. A `failed` webhook can still be retried.

`exhausted` represents the terminal retry state.

---

## 11. Indexer/Event Status

The backend uses multiple event/indexer state representations.

### Event log status

Source:

`src/models/EventLog.ts`

Canonical values:

```text
pending
processed
failed
```

Example:

```json
{
  "status": "processed",
  "ledgerSequence": 123456
}
```

### Indexer event types

The event log currently recognizes:

```text
delivery
escrow
dispute
reputation
milestone
```

Clients should not assume that an indexer event's `eventType` is equivalent to its processing `status`.

For example:

```text
eventType = escrow
status    = processed
```

are two separate fields with different meanings.

---

## 12. Pagination Contract

The shared query middleware is:

`src/middlewares/queryMiddleware.ts`

It supports:

```text
page
limit
sort
search
```

and whitelisted filter operators:

```text
eq
ne
gt
gte
lt
lte
in
nin
```

The pagination metadata generated by `buildPaginationMeta()` is:

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

### Pagination fields

| Field             | Type        | Meaning                                       |
| ----------------- | ----------- | --------------------------------------------- |
| `totalItems`      | number      | Total matching records                        |
| `totalPages`      | number      | Number of available pages                     |
| `currentPage`     | number      | Current 1-based page                          |
| `limit`           | number      | Number of records requested/returned per page |
| `hasNextPage`     | boolean     | Whether another page exists                   |
| `hasPreviousPage` | boolean     | Whether an earlier page exists                |
| `nextPage`        | number/null | Next page number when available               |
| `previousPage`    | number/null | Previous page number when available           |

### Example paginated response

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "deliveryId": "DEL-001",
        "status": "pending"
      }
    ],
    "pagination": {
      "totalItems": 137,
      "totalPages": 7,
      "currentPage": 1,
      "limit": 20,
      "hasNextPage": true,
      "hasPreviousPage": false,
      "nextPage": 2,
      "previousPage": null
    }
  },
  "error": null,
  "message": "Deliveries retrieved successfully"
}
```

> The exact collection field name (`items`, `deliveries`, `escrows`, etc.) remains endpoint-specific. The pagination metadata follows the shared structure above.

---

## 13. Query Parameters

The shared query middleware uses:

### Page

```text
?page=2
```

Pages are 1-based.

### Limit

```text
?limit=20
```

The shared middleware defaults to `20` and clamps the default maximum to `100`, unless a route supplies its own configuration.

### Sort

```text
?sort=-createdAt,name
```

A leading `-` means descending order.

### Search

```text
?search=lagos
```

Searchable fields are route-specific.

### Filters

Simple equality:

```text
?status=pending
```

Comparison:

```text
?amount[gte]=100
```

Multiple-value membership:

```text
?status[in]=pending,funded
```

Clients should only use fields explicitly exposed by the endpoint.

---

## 14. Delivery API Example

A typical delivery object can contain:

```json
{
  "deliveryId": "DEL-2026-000123",
  "trackingNumber": "TRK-000123",
  "driverId": "66f...",
  "status": "in_progress",
  "deliveryFee": 150.25,
  "deliveryFeeAsset": {
    "code": "XLM"
  },
  "pickupCoordinates": {
    "lat": 6.5244,
    "lng": 3.3792,
    "address": "Lagos"
  },
  "dropoffCoordinates": {
    "lat": 6.6018,
    "lng": 3.3515,
    "address": "Ikeja"
  },
  "createdAt": "2026-09-30T12:30:00.000Z",
  "updatedAt": "2026-09-30T13:10:00.000Z"
}
```

Important conventions demonstrated here:

* `deliveryId` is the business identifier.
* `status` uses the canonical delivery enum.
* timestamps are UTC ISO-8601.
* API-facing coordinates use `{ lat, lng }`.
* monetary fields must follow their endpoint-specific unit contract.

---

## 15. Driver Location Example

API-facing location:

```json
{
  "lat": 6.5244,
  "lng": 3.3792
}
```

Stored GeoJSON:

```json
{
  "type": "Point",
  "coordinates": [3.3792, 6.5244]
}
```

The coordinate order changes because GeoJSON requires:

```text
[lng, lat]
```

---

## 16. Escrow Example

```json
{
  "deliveryId": "DEL-2026-000123",
  "status": "locked",
  "amount": 150.25,
  "assetCode": "XLM",
  "contractId": "CABC...",
  "lockedAt": "2026-09-30T12:35:00.000Z"
}
```

The escrow model documents `amount` as an asset-unit value rather than a stroop integer.

Blockchain transaction payloads may expose the corresponding amount in stroops.

Clients must follow the specific endpoint contract instead of applying a universal conversion to every `amount` field.

---

## 17. Webhook Attempt Example

```json
{
  "status": "failed",
  "attempts": 2,
  "maxAttempts": 5,
  "lastStatusCode": 503,
  "lastAttemptAt": "2026-09-30T13:30:00.000Z",
  "nextRetryAt": "2026-09-30T13:31:00.000Z"
}
```

A `failed` state means the retry mechanism can process the attempt again.

An `exhausted` state means automatic retries have stopped.

---

## 18. Client Integration Checklist

Before integrating a new endpoint, verify:

* [ ] Monetary fields are interpreted using the endpoint's documented unit.
* [ ] Stroop integers are never converted through unsafe floating-point arithmetic.
* [ ] Timestamps are parsed as UTC.
* [ ] Timezone conversion is performed client-side.
* [ ] GeoJSON coordinates use `[lng, lat]`.
* [ ] API-facing coordinate objects use `{ lat, lng }` where applicable.
* [ ] `deliveryId` is not confused with MongoDB `_id`.
* [ ] Status values exactly match the backend enum.
* [ ] Response handling expects `success`, `data`, `error`, and `message`.
* [ ] Paginated endpoints consume the documented pagination metadata.
* [ ] Clients do not depend on human-readable `message` strings for program logic.
* [ ] Unknown enum values are handled defensively so clients remain forward-compatible.

---

## 19. Backend Source References

Primary implementation references:

* `src/utils/responseWrapper.ts`
* `src/utils/stroops.ts`
* `src/middlewares/queryMiddleware.ts`
* `src/models/Delivery.ts`
* `src/models/DriverLocation.ts`
* `src/models/Escrow.ts`
* `src/models/Dispute.ts`
* `src/models/FleetInvitation.ts`
* `src/interfaces/IFleet.ts`
* `src/models/WebhookDeliveryAttempt.ts`
* `src/models/EventLog.ts`
* `src/models/IdempotencyRecord.ts`
