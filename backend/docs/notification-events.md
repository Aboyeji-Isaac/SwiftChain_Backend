# Push Notification Event Catalog

## Overview

SwiftChain push notifications are generated from delivery lifecycle transitions and delivered through Firebase Cloud Messaging (FCM).

The primary implementation is:

```text
src/services/notificationService.ts
src/services/push/fcmProvider.ts
src/models/Notification.ts
src/models/NotificationPreference.ts
```

---

## Event Catalog

The notification service maps selected `DeliveryStatus` values to user-facing notification events.

| Event                  | Delivery trigger | Title                | Body                                                              |
| ---------------------- | ---------------- | -------------------- | ----------------------------------------------------------------- |
| `delivery.pending`     | `pending`        | Delivery created     | Delivery `<reference>` has been created and is awaiting a driver. |
| `delivery.assigned`    | `assigned`       | Driver assigned      | A driver has been assigned to delivery `<reference>`.             |
| `delivery.in_progress` | `in_progress`    | Delivery in progress | Delivery `<reference>` is on its way.                             |
| `delivery.completed`   | `completed`      | Delivery completed   | Delivery `<reference>` has been completed.                        |
| `delivery.cancelled`   | `cancelled`      | Delivery cancelled   | Delivery `<reference>` has been cancelled.                        |

The following delivery statuses are not mapped to a user-facing push event by `STATUS_EVENTS`.

For example, `FUNDED` is treated as internal escrow bookkeeping and does not produce a notification event.

---

## Notification Flow

The complete flow is:

```text
Delivery status transition
        ↓
STATUS_EVENTS
        ↓
NotificationEvent
        ↓
Resolve recipients
        ↓
Load notification preferences
        ↓
Apply push/event preferences
        ↓
Collect device tokens
        ↓
FCM provider
        ↓
Per-token fan-out
        ↓
Persist Notification result
        ↓
Prune permanently invalid tokens
```

A push-provider failure does not roll back the underlying delivery-status transition.

---

## Recipient Resolution

The notification service considers:

```text
delivery.sender
delivery.userId
delivery.driverId
```

Only valid MongoDB ObjectIds are used as notification targets.

Duplicate user IDs are removed before dispatch.

A user who appears in more than one recipient field therefore receives one notification for that transition.

---

## Notification Document

The `Notification` model persists every notification attempt, including successful sends, failures, and preference/device skips.

### Schema

```json
{
  "user": "<ObjectId>",
  "event": "delivery.assigned",
  "channel": "push",
  "title": "Driver assigned",
  "body": "A driver has been assigned to delivery TRK-1001.",
  "data": {
    "deliveryId": "<ObjectId>",
    "status": "assigned",
    "event": "delivery.assigned",
    "trackingNumber": "TRK-1001"
  },
  "status": "sent",
  "acceptedCount": 1,
  "rejectedCount": 0,
  "failureReason": null,
  "delivery": "<ObjectId>"
}
```

### Fields

| Field           | Meaning                              |
| --------------- | ------------------------------------ |
| `user`          | Notification recipient               |
| `event`         | `NotificationEvent` identifier       |
| `channel`       | Currently `push`                     |
| `title`         | User-facing notification title       |
| `body`          | User-facing notification body        |
| `data`          | Structured client-routing payload    |
| `status`        | `sent`, `failed`, or `skipped`       |
| `acceptedCount` | Number of tokens accepted by FCM     |
| `rejectedCount` | Number of rejected tokens            |
| `failureReason` | Provider or suppression reason       |
| `delivery`      | Associated delivery where applicable |
| `createdAt`     | Creation timestamp                   |
| `updatedAt`     | Last update timestamp                |

---

## Notification Status

### `sent`

At least one device token was accepted by the provider.

### `failed`

The notification was attempted but no device token was accepted, or the provider operation failed.

### `skipped`

The notification was intentionally suppressed because:

* push notifications are disabled;
* the event is not enabled;
* the user has no registered devices.

Skipped notifications are persisted for notification-history and operational visibility.

---

## Notification Preferences

Preferences are stored in:

```text
src/models/NotificationPreference.ts
```

Each user has:

```text
pushEnabled
enabledEvents[]
devices[]
```

### `pushEnabled`

Master push-notification switch.

```text
false → no push notification is sent
true  → event-level preference is evaluated
```

### `enabledEvents`

The event-level allow-list.

A notification is suppressed when its event is absent from `enabledEvents`.

New preferences default to all defined notification events.

### Preference evaluation

The effective decision is:

```text
if pushEnabled === false
    → SKIPPED

else if event not in enabledEvents
    → SKIPPED

else if devices.length === 0
    → SKIPPED

else
    → send to registered devices
```

---

## Device Registration

A registered device contains:

```json
{
  "token": "<FCM registration token>",
  "platform": "android",
  "lastSeenAt": "<timestamp>"
}
```

Supported platforms:

```text
ios
android
web
```

The notification preference document belongs to exactly one user.

The device-registration flow associates a token with that user.

A device token should therefore be treated as belonging to the user who registered it rather than as a globally routable user identity.

---

## FCM Delivery

The FCM implementation is located at:

```text
src/services/push/fcmProvider.ts
```

Authentication uses a Firebase service-account flow:

```text
Service-account private key
        ↓
Signed RS256 JWT
        ↓
Google OAuth2 token endpoint
        ↓
Short-lived OAuth2 access token
        ↓
FCM HTTP v1 API
```

The OAuth access token is cached and refreshed before expiry.

---

## FCM Payload

Each device receives an HTTP v1 FCM message equivalent to:

```json
{
  "message": {
    "token": "<device-token>",
    "notification": {
      "title": "Driver assigned",
      "body": "A driver has been assigned to delivery TRK-1001."
    },
    "data": {
      "deliveryId": "<ObjectId>",
      "status": "assigned",
      "event": "delivery.assigned",
      "trackingNumber": "TRK-1001"
    }
  }
}
```

The `data` fields are string values because they are passed through the FCM data-message contract.

---

## Per-Token Fan-Out

FCM sends are performed individually per registered token.

For a user with:

```text
3 registered tokens
```

the provider makes:

```text
3 token-level send attempts
```

The results are aggregated into:

```text
acceptedCount
rejectedCount
invalidTokens
```

One failed or invalid device does not automatically fail sends to the other devices.

---

## Invalid Device Token Pruning

The FCM provider classifies permanent token failures including:

```text
UNREGISTERED
INVALID_ARGUMENT
SENDER_ID_MISMATCH
```

Permanently invalid tokens are returned as `invalidTokens`.

The notification service then calls the preference repository to remove them.

Transient failures are not automatically treated as permanent token invalidation.

---

## Notification History

Notification history is stored in MongoDB.

The notification model has indexes supporting:

```text
(user, createdAt DESC)
(delivery, createdAt DESC)
```

This supports:

* user notification history
* delivery-specific notification troubleshooting

---

## Adding a New Notification Event

A new notification event should be added end to end.

### 1. Define the event

Add the event to:

```text
src/models/NotificationPreference.ts
```

Example:

```ts
NEW_EVENT = 'delivery.example'
```

### 2. Map the delivery transition

Update `STATUS_EVENTS` in:

```text
src/services/notificationService.ts
```

Example:

```ts
[DeliveryStatus.EXAMPLE]: NotificationEvent.NEW_EVENT,
```

### 3. Define notification copy

Add title and body generation to `EVENT_COPY`.

### 4. Verify payload data

Ensure the dispatch payload includes the data fields required by the client.

### 5. Verify preference behaviour

Because `enabledEvents` controls event-level opt-in, the new event must be included in the default preference strategy where appropriate.

### 6. Verify persistence

The notification service automatically persists the result through the notification repository.

### 7. Verify FCM

The existing FCM provider handles token fan-out, provider responses, accepted/rejected counts, and permanent-token pruning.

### 8. Update this catalog

Add:

* event name
* delivery trigger
* title
* body
* payload example
* client routing expectations

### 9. Add tests

Cover:

* transition-to-event mapping
* preference filtering
* payload generation
* notification persistence
* FCM success
* FCM failure
* invalid-token pruning

---

## Source References

```text
src/services/notificationService.ts
src/services/push/fcmProvider.ts
src/models/Notification.ts
src/models/NotificationPreference.ts
src/repositories/NotificationRepository.ts
src/repositories/NotificationPreferenceRepository.ts
```
