# Driver and DriverProfile API Reference

## Base URL

All endpoints are mounted under:

```text
/api/v1/drivers
```

Successful JSON responses use the standard envelope:

```json
{
  "success": true,
  "data": {},
  "error": null,
  "message": "Operation successful"
}
```

Errors use:

```json
{
  "success": false,
  "data": null,
  "error": "Error description",
  "message": "Human-readable message"
}
```

## Authentication

Authenticated endpoints require:

```http
Authorization: Bearer <JWT>
```

Driver-only endpoints additionally require the authenticated user's role to be `driver`.

---

## DriverProfile

`DriverProfile` stores driver reputation, delivery statistics, rating state, and optional vehicle information.

### Schema

| Field                 | Type      | Description                                                           |
| --------------------- | --------- | --------------------------------------------------------------------- |
| `userId`              | ObjectId  | Associated `User` ID; unique per driver                               |
| `reputationPoints`    | number    | Reputation score; defaults to `0`                                     |
| `tier`                | string    | `bronze`, `silver`, `gold`, or `platinum`                             |
| `totalDeliveries`     | number    | Total deliveries assigned/completed according to the profile counters |
| `completedDeliveries` | number    | Completed delivery count                                              |
| `rating`              | number    | Stored driver rating from `0` to `5`                                  |
| `delayedDeliveries`   | number    | Delayed delivery count                                                |
| `cancelledDeliveries` | number    | Cancelled delivery count                                              |
| `isSuspended`         | boolean   | Whether the driver profile is temporarily suspended                   |
| `suspendedUntil`      | date/null | Suspension expiry                                                     |
| `suspensionReason`    | string    | Reason for suspension                                                 |
| `vehicleDetails`      | object    | Driver vehicle information                                            |
| `isDeleted`           | boolean   | Driver profile soft-delete flag                                       |
| `deletedAt`           | date/null | Soft-delete timestamp                                                 |

### Vehicle Details

| Field         | Type   | Validation                                         |
| ------------- | ------ | -------------------------------------------------- |
| `make`        | string | Required, trimmed                                  |
| `model`       | string | Required, trimmed                                  |
| `year`        | number | Optional; minimum `1980`, maximum current year + 1 |
| `plateNumber` | string | Required, trimmed, stored uppercase                |
| `capacityKg`  | number | Optional; must not be negative                     |

---

# Endpoints

## 1. Get Driver Leaderboard

```http
GET /api/v1/drivers/leaderboard
```

**Authentication:** Public

Returns drivers ordered by descending `reputationPoints`.

### Query Parameters

| Parameter | Type    | Default | Description         |
| --------- | ------- | ------: | ------------------- |
| `page`    | integer |     `1` | 1-based page number |
| `limit`   | integer |    `20` | Maximum `100`       |

### Example

```bash
curl -X GET "http://localhost:3000/api/v1/drivers/leaderboard?page=1&limit=20"
```

### Response

```json
{
  "success": true,
  "data": {
    "data": [
      {
        "rank": 1,
        "userId": "65f000000000000000000001",
        "reputationPoints": 1250,
        "tier": "gold",
        "totalDeliveries": 180,
        "completedDeliveries": 172
      }
    ],
    "pagination": {
      "total": 50,
      "page": 1,
      "limit": 20,
      "totalPages": 3
    }
  },
  "error": null,
  "message": "Leaderboard retrieved successfully"
}
```

---

## 2. Update Driver Vehicle

```http
PATCH /api/v1/drivers/me/vehicle
```

**Authentication:** Driver

### Request Body

```json
{
  "make": "Toyota",
  "model": "Corolla",
  "year": 2022,
  "plateNumber": "LAG-123-AB",
  "capacityKg": 500
}
```

`make`, `model`, and `plateNumber` are required.

### Example

```bash
curl -X PATCH "http://localhost:3000/api/v1/drivers/me/vehicle" \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{
    "make": "Toyota",
    "model": "Corolla",
    "year": 2022,
    "plateNumber": "LAG-123-AB",
    "capacityKg": 500
  }'
```

### Errors

* `400` — missing/invalid `make`, `model`, `plateNumber`, `year`, or `capacityKg`.
* `401` — authentication required.
* `403` — authenticated user is not a driver.
* `500` — persistence failure.

---

## 3. Get Nearby Drivers

```http
GET /api/v1/drivers/nearby
```

**Authentication:** Authenticated user

### Query Parameters

| Parameter       | Required | Description                                                |
| --------------- | -------- | ---------------------------------------------------------- |
| `lat`           | Yes      | Latitude from `-90` to `90`                                |
| `lng`           | Yes      | Longitude from `-180` to `180`                             |
| `radiusMeters`  | No       | Positive radius; default `5000m`, maximum `50000m`         |
| `limit`         | No       | Positive integer; capped by `DRIVER_PROXIMITY_MAX_RESULTS` |
| `availableOnly` | No       | Boolean; defaults to `true`                                |
| `status`        | No       | `online`, `offline`, or `on_delivery`                      |

### Example

```bash
curl -X GET \
  "http://localhost:3000/api/v1/drivers/nearby?lat=6.5244&lng=3.3792&radiusMeters=5000&availableOnly=true" \
  -H "Authorization: Bearer <JWT>"
```

### Response

```json
{
  "success": true,
  "data": {
    "drivers": [
      {
        "driverId": "65f000000000000000000001",
        "distanceMeters": 842,
        "lat": 6.525,
        "lng": 3.378,
        "isAvailable": true,
        "status": "online",
        "heading": 90,
        "speed": 8.5,
        "accuracy": 12,
        "recordedAt": "2026-09-30T10:00:00.000Z"
      }
    ],
    "count": 1,
    "radiusMeters": 5000,
    "center": {
      "lat": 6.5244,
      "lng": 3.3792
    }
  },
  "error": null,
  "message": "Found 1 driver(s) within 5000m"
}
```

The proximity query uses `DriverLocation` GeoJSON `Point` data and MongoDB `2dsphere` indexes. GeoJSON coordinates are stored as `[longitude, latitude]`.

The availability-aware index is:

```text
{ isAvailable: 1, status: 1, location: "2dsphere" }
```

---

## 4. Explain Nearby Driver Query

```http
GET /api/v1/drivers/nearby/explain
```

**Authentication:** Admin

### Query Parameters

Uses the same parameters as `/nearby`:

* `lat`
* `lng`
* `radiusMeters`
* `limit`
* `availableOnly`
* `status`

### Example

```bash
curl -X GET \
  "http://localhost:3000/api/v1/drivers/nearby/explain?lat=6.5244&lng=3.3792&radiusMeters=5000" \
  -H "Authorization: Bearer <ADMIN_JWT>"
```

### Response

The endpoint returns query-planner information including:

```json
{
  "success": true,
  "data": {
    "indexUsed": "availability_location_2dsphere",
    "executionTimeMillis": 2,
    "totalDocsExamined": 4,
    "nReturned": 3,
    "raw": {}
  },
  "error": null,
  "message": "Proximity query plan retrieved successfully"
}
```

The raw MongoDB execution plan is included for index diagnostics.

---

## 5. Update Driver Location

```http
PUT /api/v1/drivers/me/location
```

**Authentication:** Driver

### Request Body

```json
{
  "lat": 6.5244,
  "lng": 3.3792,
  "isAvailable": true,
  "status": "online",
  "heading": 90,
  "speed": 8.5,
  "accuracy": 12,
  "currentDeliveryId": "65f000000000000000000010",
  "recordedAt": "2026-09-30T10:00:00.000Z"
}
```

Only `lat` and `lng` are required.

### Example

```bash
curl -X PUT "http://localhost:3000/api/v1/drivers/me/location" \
  -H "Authorization: Bearer <DRIVER_JWT>" \
  -H "Content-Type: application/json" \
  -d '{
    "lat": 6.5244,
    "lng": 3.3792,
    "isAvailable": true,
    "status": "online",
    "heading": 90,
    "speed": 8.5,
    "accuracy": 12
  }'
```

### Validation

* `lat`: `-90` through `90`.
* `lng`: `-180` through `180`.
* `status`: `online`, `offline`, `on_delivery`.
* `heading`: `0` through `360`.
* `speed`: non-negative.
* `accuracy`: non-negative.
* `currentDeliveryId`: valid MongoDB ObjectId when supplied.
* `recordedAt`: valid date when supplied.

Location records are upserted by `driverId`, so the current-location collection maintains one current document per driver.

---

## 6. Get Driver Location

```http
GET /api/v1/drivers/:driverId/location
```

**Authentication:** Authenticated user

### Example

```bash
curl -X GET \
  "http://localhost:3000/api/v1/drivers/65f000000000000000000001/location" \
  -H "Authorization: Bearer <JWT>"
```

### Errors

* `400` — invalid driver ObjectId.
* `401` — authentication required.
* `404` — no current location exists.

---

## 7. Get Driver Earnings

```http
GET /api/v1/drivers/:id/earnings
```

**Authentication:** Driver themselves or Admin

### Query Parameters

| Parameter   | Type   | Description                                  |
| ----------- | ------ | -------------------------------------------- |
| `groupBy`   | string | `day`, `week`, or `month`; defaults to `day` |
| `startDate` | date   | Optional lower bound for `releasedAt`        |
| `endDate`   | date   | Optional upper bound for `releasedAt`        |

### Example

```bash
curl -X GET \
  "http://localhost:3000/api/v1/drivers/65f000000000000000000001/earnings?groupBy=month&startDate=2026-01-01&endDate=2026-09-30" \
  -H "Authorization: Bearer <JWT>"
```

### Earnings Source

Only escrows with:

```text
status = released
```

are included.

The aggregation joins the escrow with its delivery and matches the delivery's `driverId`.

### Response

```json
{
  "success": true,
  "data": {
    "driverId": "65f000000000000000000001",
    "groupBy": "month",
    "periods": [
      {
        "period": "2026-09",
        "totalAmount": 125000,
        "deliveryCount": 18
      }
    ],
    "summary": {
      "totalAmount": 125000,
      "totalDeliveries": 18
    }
  },
  "error": null,
  "message": "Driver earnings retrieved successfully"
}
```

### Errors

* `400` — invalid driver ID, invalid `groupBy`, or invalid date range.
* `401` — authentication required.
* `403` — requesting another driver's earnings without admin privileges.

---

## Related Implementation

```text
src/routes/driverRoutes.ts
src/controllers/driverController.ts
src/controllers/driverLocationController.ts
src/controllers/driverEarningsController.ts
src/services/driverService.ts
src/services/driverLocationService.ts
src/services/driverEarningsService.ts
src/models/DriverProfile.ts
src/models/DriverLocation.ts
src/models/Escrow.ts
```
