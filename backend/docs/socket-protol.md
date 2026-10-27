# Socket.IO Realtime Protocol Reference

## Overview

SwiftChain uses Socket.IO for authenticated realtime communication between drivers, merchants, and other clients.

Primary implementation files:

```text
src/sockets/connectionHandler.ts
src/sockets/socket.types.ts
src/sockets/locationHandler.ts
src/sockets/syncHandler.ts
src/sockets/socket.service.ts
src/sockets/sync.service.ts
src/sockets/messageQueue.ts
src/config/env.ts
```

---

## Connection

The server is initialized by `initializeSocketServer()`.

Production transport:

```text
websocket
```

Development/test transport:

```text
websocket
polling
```

CORS is controlled by:

```text
CORS_ORIGIN
```

Socket.IO heartbeat configuration:

```text
SOCKET_PING_INTERVAL_MS
SOCKET_PING_TIMEOUT_MS
```

---

## Authentication Handshake

The supported client handshake is:

```ts
import { io } from 'socket.io-client';

const socket = io(API_URL, {
  auth: {
    token: `Bearer ${jwt}`,
  },
});
```

The server reads:

```text
socket.handshake.auth.token
```

and verifies the JWT using `JWT_SECRET`.

The decoded `userId` and token expiry are stored in socket state.

The implementation also contains a query-token helper for compatibility:

```ts
const socket = io(API_URL, {
  query: {
    token: jwt,
  },
});
```

The active connection setup primarily extracts the token from `handshake.auth`.

---

## Authentication State

Authenticated socket state includes:

```text
userId
token
tokenExp
connectedAt
rooms
```

The socket service tracks active connections and room membership.

Unauthenticated sockets may connect, but protected operations such as driver location updates and offline location synchronization require an authenticated `userId`.

---

# Rooms

Delivery tracking rooms use:

```text
delivery:<deliveryId>
```

Example:

```text
delivery:66f123456789abcdef123456
```

Clients join using:

```ts
socket.emit(
  'join_room',
  'delivery:66f123456789abcdef123456',
);
```

The connection handler calls:

```ts
socket.join(room);
```

and records the room membership.

Clients leave with:

```ts
socket.emit(
  'leave_room',
  'delivery:66f123456789abcdef123456',
);
```

The server then calls:

```ts
socket.leave(room);
```

---

# Client-to-Server Events

## `join_room`

Payload:

```text
string
```

Example:

```ts
socket.emit('join_room', `delivery:${deliveryId}`);
```

The server joins the socket to the requested room and tracks membership.

---

## `leave_room`

Payload:

```text
string
```

Example:

```ts
socket.emit('leave_room', `delivery:${deliveryId}`);
```

The socket leaves the room and membership tracking is updated.

---

## `driver_location_update`

Used by an authenticated driver to submit a live GPS update.

Payload:

```ts
interface DriverLocationUpdatePayload {
  deliveryId: string;
  lat: number;
  lng: number;
  capturedAt?: number;
}
```

Example:

```ts
socket.emit('driver_location_update', {
  deliveryId,
  lat: 6.5244,
  lng: 3.3792,
  capturedAt: Date.now(),
});
```

The handler requires:

```text
socket.data.userId
```

If the socket is unauthenticated, the server responds with:

```json
{
  "success": false,
  "error": "Authentication required"
}
```

---

## `location_sync`

Used after a driver reconnects to submit location points buffered while offline.

Payload:

```ts
interface LocationSyncPayload {
  updates: OfflineLocationPoint[];
}

interface OfflineLocationPoint {
  capturedAt: number;
  lat: number;
  lng: number;
  deliveryId?: string;
}
```

Example:

```ts
socket.emit('location_sync', {
  updates: [
    {
      capturedAt: 1727690000000,
      lat: 6.5244,
      lng: 3.3792,
      deliveryId,
    },
    {
      capturedAt: 1727690005000,
      lat: 6.5250,
      lng: 3.3800,
      deliveryId,
    },
  ],
});
```

The server delegates processing to `syncService.processBatch()`.

The configured batch limit is:

```text
SYNC_BATCH_SIZE_LIMIT
```

Default:

```text
500
```

The synchronization service processes the batch and returns per-item results.

---

## `pong`

Payload:

```ts
interface PongPayload {
  timestamp: number;
  latency?: number;
}
```

Example:

```ts
socket.emit('pong', {
  timestamp: Date.now(),
});
```

The socket service uses the event for application-level health tracking.

---

## `auth_refresh`

Used to replace the JWT during an existing connection.

Payload:

```ts
interface AuthRefreshPayload {
  token: string;
}
```

Example:

```ts
socket.emit('auth_refresh', {
  token: `Bearer ${newJwt}`,
});
```

The server verifies the token and retrieves the associated user.

Invalid or inactive users receive:

```json
{
  "success": false,
  "error": "Invalid or inactive token"
}
```

A successful refresh produces:

```json
{
  "success": true
}
```

---

## `refresh_token`

Legacy token refresh event.

Payload:

```ts
interface RefreshTokenPayload {
  token: string;
}
```

The connection handler accepts either:

```text
Bearer <jwt>
```

or the raw JWT.

Invalid tokens cause:

```text
auth_expired
disconnect
```

---

## `message_ack`

Acknowledges a queued server-to-client message.

Payload:

```text
messageId: string
```

Example:

```ts
socket.emit('message_ack', messageId);
```

The server verifies the socket has a `userId` and removes the corresponding queued message.

---

# Server-to-Client Events

## `location:update`

Broadcast to subscribers of a delivery room.

Payload:

```ts
interface LocationBroadcastPayload {
  deliveryId: string;
  driverId: string;
  lat: number;
  lng: number;
  capturedAt: number;
  receivedAt: string;
}
```

Example:

```json
{
  "deliveryId": "66f123456789abcdef123456",
  "driverId": "66f987654321abcdef654321",
  "lat": 6.5244,
  "lng": 3.3792,
  "capturedAt": 1727690000000,
  "receivedAt": "2026-09-30T10:30:00.000Z"
}
```

Clients should listen with:

```ts
socket.on('location:update', (payload) => {
  console.log(payload);
});
```

Only clients in the relevant delivery room receive the delivery location broadcast.

---

## `location_update_ack`

Returned to the driver after a live location update.

Payload:

```ts
interface LocationUpdateAck {
  success: boolean;
  locationId?: string;
  error?: string;
  isDuplicate?: boolean;
  isStale?: boolean;
}
```

Example success:

```json
{
  "success": true,
  "locationId": "66fa..."
}
```

Duplicate:

```json
{
  "success": false,
  "isDuplicate": true
}
```

Stale:

```json
{
  "success": false,
  "isStale": true
}
```

---

## `location_sync_ack`

Returned after offline synchronization.

Payload:

```ts
interface LocationSyncAck {
  processedAt: string;
  received: number;
  saved: number;
  duplicates: number;
  failed: number;
  results: SyncItemResult[];
}
```

Each result is:

```ts
interface SyncItemResult {
  capturedAt: number;
  status: 'saved' | 'duplicate' | 'invalid' | 'error';
  reason?: string;
}
```

---

## `auth_expired`

Sent when periodic JWT validation determines that the socket's token is no longer valid.

Payload:

```ts
interface AuthExpiredPayload {
  message: string;
  gracePeriodMs: number;
}
```

Example:

```json
{
  "message": "Your session has expired. Please refresh your token.",
  "gracePeriodMs": 30000
}
```

---

## `auth_refresh_ack`

Acknowledges an `auth_refresh` request.

Payload:

```ts
interface AuthRefreshAckPayload {
  success: boolean;
  error?: string;
}
```

---

## `ping`

Application-level server heartbeat payload:

```ts
interface PingPayload {
  timestamp: number;
}
```

Socket.IO also provides its transport-level heartbeat independently.

---

# Token Expiry and Grace Period

The server periodically validates authenticated socket tokens.

Configuration:

```text
SOCKET_TOKEN_CHECK_INTERVAL_MS
SOCKET_TOKEN_GRACE_PERIOD_MS
```

Default values:

```text
SOCKET_TOKEN_CHECK_INTERVAL_MS = 60000
SOCKET_TOKEN_GRACE_PERIOD_MS = 30000
```

Flow:

```text
Connected
   |
   v
Periodic JWT validation
   |
   +---- valid ----> continue
   |
   +---- invalid/expired
              |
              v
        emit auth_expired
              |
              v
       start grace timer
              |
       +------+------+
       |             |
       v             v
auth_refresh     grace expires
       |             |
       v             v
clear timer       disconnect
continue
```

A successful `auth_refresh` clears the grace timer.

---

# Offline Synchronization

The offline flow is:

```text
Driver loses connectivity
        |
        v
Client buffers GPS points
        |
        v
Connection restored
        |
        v
location_sync
        |
        v
syncService.processBatch()
        |
        +---- saved
        +---- duplicate
        +---- invalid
        +---- error
        |
        v
location_sync_ack
```

The configured maximum batch size is:

```text
SYNC_BATCH_SIZE_LIMIT
```

Default:

```text
500
```

Location synchronization returns a per-item result so mobile clients can reconcile saved, duplicate, invalid, and failed points.

---

# Message Queue and ACK Semantics

`src/sockets/messageQueue.ts` stores queued messages per user.

A queued message contains:

```ts
interface QueuedSocketMessage<T = unknown> {
  id: string;
  userId: string;
  event: string;
  payload: T;
  queuedAt: number;
  updatedAt: number;
  ackRequired: boolean;
  retries: number;
  ackTimeoutMs: number;
}
```

Default ACK timeout:

```text
SOCKET_MESSAGE_ACK_TIMEOUT_MS
```

Default:

```text
15000 ms
```

A queued message is removed when the client acknowledges it with a non-null/non-undefined acknowledgement.

---

# Client Location Streaming Example

```ts
import { io } from 'socket.io-client';

const socket = io(API_URL, {
  auth: {
    token: `Bearer ${jwt}`,
  },
});

socket.on('connect', () => {
  socket.emit('join_room', `delivery:${deliveryId}`);
});

socket.emit('driver_location_update', {
  deliveryId,
  lat: 6.5244,
  lng: 3.3792,
  capturedAt: Date.now(),
});

socket.on('location_update_ack', (ack) => {
  if (!ack.success) {
    console.error('Location update failed:', ack.error);
  }
});

socket.on('location:update', (location) => {
  console.log('Driver location:', location);
});

socket.on('auth_expired', (payload) => {
  refreshJwt().then((newToken) => {
    socket.emit('auth_refresh', {
      token: `Bearer ${newToken}`,
    });
  });
});

socket.on('auth_refresh_ack', (ack) => {
  if (!ack.success) {
    console.error('Socket token refresh failed:', ack.error);
  }
});
```

---

# Source of Truth

```text
src/sockets/connectionHandler.ts
src/sockets/socket.types.ts
src/sockets/locationHandler.ts
src/sockets/syncHandler.ts
src/sockets/socket.service.ts
src/sockets/sync.service.ts
src/sockets/messageQueue.ts
src/config/env.ts
```
