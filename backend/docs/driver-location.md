# Driver Location and Geospatial System

## Architecture

Driver location tracking uses two MongoDB collections:

```text
DriverLocation
    └── Current position, one document per driver

LocationUpdate
    └── Historical location updates and processing state
```

`DriverLocation` is optimized for proximity searches. `LocationUpdate` preserves incoming location history.

```text
Driver
  │
  ├── Live location
  │      ↓
  │  DriverLocation
  │      ↓
  │  2dsphere / $geoNear
  │      ↓
  │  Nearby drivers
  │
  └── Location update
         ↓
     LocationUpdate
         ↓
     pending → processed / failed
```

## DriverLocation

Each driver has one current `DriverLocation` document.

```ts
{
  driverId: ObjectId,
  location: {
    type: "Point",
    coordinates: [longitude, latitude]
  },
  isAvailable: boolean,
  status: "online" | "offline" | "on_delivery",
  heading?: number,
  speed?: number,
  accuracy?: number,
  currentDeliveryId?: ObjectId,
  recordedAt: Date,
  expiresAt: Date
}
```

### GeoJSON Coordinates

MongoDB GeoJSON uses:

```text
[longitude, latitude]
```

not:

```text
[latitude, longitude]
```

For example:

```json
{
  "type": "Point",
  "coordinates": [3.3792, 6.5244]
}
```

The service converts API latitude/longitude input into this representation.

## Driver Location Fields

| Field               | Description                                 |
| ------------------- | ------------------------------------------- |
| `driverId`          | Unique driver reference                     |
| `location`          | Current GeoJSON `Point`                     |
| `isAvailable`       | Whether the driver can accept an assignment |
| `status`            | `online`, `offline`, or `on_delivery`       |
| `heading`           | Direction in degrees, `0–360`               |
| `speed`             | Ground speed in metres/second               |
| `accuracy`          | Device-reported accuracy in metres          |
| `currentDeliveryId` | Active delivery when assigned               |
| `recordedAt`        | Device capture time                         |
| `expiresAt`         | TTL expiration timestamp                    |

Coordinates are validated as:

```text
latitude:  -90 .. 90
longitude: -180 .. 180
```

## Indexes

`DriverLocation` maintains:

```js
{ location: "2dsphere" }
```

```js
{
  isAvailable: 1,
  status: 1,
  location: "2dsphere"
}
```

```js
{
  expiresAt: 1
}
```

The TTL index uses:

```js
{ expireAfterSeconds: 0 }
```

This means MongoDB expires the document at the exact `expiresAt` value.

The unique `driverId` index ensures one current location document per driver.

## Location Expiry

The location lifetime is controlled by:

```env
DRIVER_LOCATION_STALE_AFTER_SECONDS=300
```

The default is 300 seconds.

`expiresAt` is calculated from `recordedAt`:

```ts
expiresAt =
  recordedAt +
  DRIVER_LOCATION_STALE_AFTER_SECONDS
```

Every new location update refreshes the driver's current record.

## LocationUpdate

`LocationUpdate` stores individual incoming GPS updates.

```ts
{
  driverId: ObjectId,
  deliveryId?: ObjectId,
  coordinates: {
    lat: number,
    lng: number
  },
  capturedAt: Date,
  isOfflineSync: boolean,
  status: "pending" | "processed" | "failed",
  errorMessage?: string
}
```

Unlike `DriverLocation`, these coordinates use the API convention:

```json
{
  "lat": 6.5244,
  "lng": 3.3792
}
```

## Location Ingestion Rules

Environment configuration:

```env
LOCATION_DEDUP_TTL_SECONDS=60
LOCATION_MAX_AGE_MS=300000
LOCATION_MAX_FUTURE_MS=30000
SYNC_BATCH_SIZE_LIMIT=500
```

### `capturedAt`

Location updates are rejected when they are older than:

```text
LOCATION_MAX_AGE_MS
```

The default is 5 minutes.

Future timestamps are permitted only within:

```text
LOCATION_MAX_FUTURE_MS
```

The default future-clock tolerance is 30 seconds.

### Offline Sync

Offline updates are marked:

```json
{
  "isOfflineSync": true
}
```

Live updates use:

```json
{
  "isOfflineSync": false
}
```

A sync batch cannot exceed:

```text
SYNC_BATCH_SIZE_LIMIT
```

The default is 500 records.

## Deduplication

Redis is used to prevent duplicate location processing.

```env
LOCATION_DEDUP_TTL_SECONDS=60
```

The deduplication key remains active for the configured TTL.

This protects the location pipeline from repeated delivery of the same update during live or offline synchronization.

## Proximity Search

Nearby drivers are queried through MongoDB `$geoNear`.

Example service input:

```ts
await driverLocationService.findNearbyDrivers({
  lat: 6.5244,
  lng: 3.3792,
  radiusMeters: 5000,
  limit: 20,
  availableOnly: true,
  status: 'online',
});
```

The generated query uses:

```js
{
  $geoNear: {
    near: {
      type: "Point",
      coordinates: [lng, lat]
    },
    distanceField: "distanceMeters",
    maxDistance: radiusMeters,
    spherical: true,
    query: {
      isAvailable: true,
      status: "online"
    },
    key: "location"
  }
}
```

### Proximity Defaults

```env
DRIVER_PROXIMITY_DEFAULT_RADIUS_M=5000
DRIVER_PROXIMITY_MAX_RADIUS_M=50000
DRIVER_PROXIMITY_MAX_RESULTS=50
```

The requested radius cannot exceed the configured maximum.

The result limit is capped by `DRIVER_PROXIMITY_MAX_RESULTS`.

## Radius Expansion During Assignment

Automatic driver assignment starts with:

```env
DRIVER_PROXIMITY_DEFAULT_RADIUS_M=5000
```

When no driver is available, the assignment service doubles the radius:

```text
5,000m
10,000m
20,000m
40,000m
...
```

The expansion is capped by:

```env
DRIVER_PROXIMITY_MAX_RADIUS_M=50000
```

The number of expansion cycles is controlled by:

```env
ASSIGNMENT_RADIUS_EXPANSION_STEPS=3
```

A Redis distributed lock protects concurrent assignment attempts for the same delivery.

Driver claiming is also atomic:

```ts
findOneAndUpdate(
  {
    driverId,
    isAvailable: true
  },
  {
    $set: {
      isAvailable: false,
      status: 'on_delivery'
    }
  }
)
```

If the claim loses a race, the next nearest candidate is attempted.

## Explain and Index Verification

The location service exposes an explain path for proximity queries.

It reports:

```text
indexUsed
executionTimeMillis
totalDocsExamined
nReturned
```

Indexes can also be explicitly synchronized with:

```ts
await driverLocationService.ensureIndexes();
```

MongoDB index creation can therefore be verified after deployment.

## Socket Location Flow

The socket layer supports live location updates and offline synchronization through:

```text
driver_location_update
location_sync
```

A live update follows:

```text
Driver
  ↓
driver_location_update
  ↓
validation / deduplication
  ↓
DriverLocation update
  ↓
LocationUpdate history
  ↓
ACK
```

Offline synchronization follows:

```text
Driver
  ↓
location_sync
  ↓
batch validation
  ↓
deduplication
  ↓
LocationUpdate persistence
  ↓
current DriverLocation updates
  ↓
ACK
```

The socket transport also uses configurable ACK timeout and heartbeat settings:

```env
SOCKET_MESSAGE_ACK_TIMEOUT_MS=15000
SOCKET_PING_TIMEOUT_MS=20000
SOCKET_PING_INTERVAL_MS=25000
SOCKET_MAX_MISSED_PONGS=2
```

## Example Location Payload

```json
{
  "driverId": "64f000000000000000000001",
  "lat": 6.5244,
  "lng": 3.3792,
  "isAvailable": true,
  "status": "online",
  "heading": 180,
  "speed": 8.5,
  "accuracy": 12,
  "recordedAt": "2026-09-30T10:00:00.000Z"
}
```

## Database Index Creation

Mongoose defines the indexes directly on `DriverLocation`.

The equivalent MongoDB commands are:

```js
db.driverlocations.createIndex(
  { location: "2dsphere" },
  { name: "location_2dsphere" }
)

db.driverlocations.createIndex(
  {
    isAvailable: 1,
    status: 1,
    location: "2dsphere"
  },
  { name: "availability_location_2dsphere" }
)

db.driverlocations.createIndex(
  { expiresAt: 1 },
  {
    name: "driver_location_ttl",
    expireAfterSeconds: 0
  }
)
```

`LocationUpdate` additionally uses indexes for driver/status/capture ordering and delivery/capture lookups.

## Implementation References

```text
src/models/DriverLocation.ts
src/models/LocationUpdate.ts
src/services/driverLocationService.ts
src/services/assignmentService.ts
src/config/env.ts
tests/driverLocation.test.ts
tests/location.service.test.ts
tests/locationHandler.test.ts
tests/sync.service.test.ts
tests/integration/socketLocation.test.ts
```
