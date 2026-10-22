# SwiftChain Backend Database Schema Reference

## Purpose

This document is the canonical reference for the Mongoose models under:

```text
src/models/
```

When a model, field, enum, virtual, or index changes, this document should be updated in the same change.

## Index Strategy

The repository uses several MongoDB index patterns:

* **Unique indexes** — enforce application-level identity constraints.
* **Sparse unique indexes** — allow missing optional values while preventing duplicate populated values.
* **Partial unique indexes** — enforce uniqueness only for documents matching a condition.
* **TTL indexes** — automatically remove expired documents.
* **Compound indexes** — support common filtering and sorting patterns.
* **`2dsphere` indexes** — support driver proximity queries.

## Models

### `User`

**File:** `src/models/User.ts`

**Purpose:** Authentication, account identity, roles, account status, wallet association and soft deletion.

**Key fields:**

* `email: string` — required, unique, lowercase.
* `password: string` — required and excluded from normal selection.
* `firstName: string`
* `lastName: string`
* `role: UserRole`
* `status: UserStatus`
* `suspendedReason?: string`
* `suspendedAt?: Date`
* `isActive: boolean`
* `walletAddress?: string`
* `profilePicture?: string`
* `profilePictureKey?: string`
* `isDeleted: boolean`
* `deletedAt?: Date`
* `deletedBy?: string`
* `createdAt`, `updatedAt`

**Indexes:**

* unique `email`
* sparse unique `walletAddress`
* `{ email: 1 }`
* `{ role: 1, status: 1 }`
* `{ isDeleted: 1, status: 1 }`

**Methods:** `comparePassword`, `softDelete`, `restore`.

---

### `Delivery`

**File:** `src/models/Delivery.ts`

**Purpose:** Primary delivery record.

**Key fields:**

* `deliveryId: string`
* `driverId: string`
* `userId: string`
* `sender: ObjectId -> User`
* `recipient: ObjectId -> User`
* `contractId?: string`
* `metadata?: Mixed`
* `trackingNumber?: string`
* `customer?: ICustomer`
* `pickup?: ILocation`
* `dropoff?: ILocation`
* `package?: IPackage`
* `deliveryFee?: number`
* `deliveryFeeAsset?: Asset`
* `escrowAmount?: number`
* `escrowAsset?: Asset`
* `notes?: string`
* `pickupCoordinates`
* `dropoffCoordinates`
* `status: DeliveryStatus`
* `distance?: number`
* `estimatedDuration?: number`
* `actualDuration?: number`
* `proofOfDelivery?: IProofOfDelivery`
* `isDeleted?: boolean`
* `deletedAt?: Date`
* `deletedBy?: string`
* `createdAt`, `updatedAt`

**`DeliveryStatus`:**

`pending`, `funded`, `assigned`, `in_progress`, `completed`, `cancelled`.

**Indexes:**

* sparse unique `deliveryId`
* sparse unique `trackingNumber`
* `{ status: 1, createdAt: -1 }`
* `{ driver: 1, createdAt: -1 }`
* `{ isDeleted: 1, deletedAt: -1 }`

**Methods:** `softDelete`, `restore`.

---

### `Escrow`

**File:** `src/models/Escrow.ts`

**Purpose:** Represents Soroban escrow state associated with a delivery.

**Key fields:**

* `delivery: ObjectId -> Delivery`
* `status: EscrowStatus`
* `amount: number`
* `assetCode: string`
* `assetIssuer?: string`
* `contractId?: string`
* `payerAddress?: string`
* `payeeAddress?: string`
* `lockTransactionHash?: string`
* `releaseTransactionHash?: string`
* `refundTransactionHash?: string`
* `lockedAt?: Date`
* `releasedAt?: Date`
* `refundedAt?: Date`
* `lastSyncedLedger?: number`
* `disputeReason?: string`
* `expiresAt?: Date`
* `flaggedAt?: Date`
* `flaggedLedger?: number`
* `resolvedAt?: Date`
* `resolvedBy?: string`
* `resolutionNotes?: string`
* `transactions: IEscrowTransaction[]`

**`EscrowStatus`:**

`pending`, `locked`, `released`, `refunded`, `disputed`, `expired`, `resolved`.

**Indexes:**

* unique `delivery`
* unique sparse `contractId`
* `{ status: 1 }`
* `{ expiresAt: 1 }`
* unique sparse `{ transactions.hash: 1 }`

**Virtuals:**

* `isFundsLocked`
* `isSettled`

---

### `Dispute`

**File:** `src/models/Dispute.ts`

**Purpose:** Delivery dispute lifecycle and on-chain dispute tracking.

**Key fields:**

* `disputeId?: string`
* `deliveryId: string`
* `openedBy?: string`
* `raisedBy: string`
* `reason: DisputeReason`
* `description: string`
* `evidenceUrls: string[]`
* `status: DisputeStatus`
* `openedLedger?: number`
* `raisedAtLedger?: number`
* `resolution?: string`
* `resolvedLedger?: number`
* `resolvedAt?: Date`
* `resolvedBy?: string`
* `resolutionNotes?: string`
* `createdAt`, `updatedAt`

**`DisputeReason`:**

`damaged_package`, `late_delivery`, `wrong_item`, `non_delivery`, `other`.

**`DisputeStatus`:**

`open`, `under_review`, `resolved`, `rejected`.

**Indexes:**

* sparse `{ disputeId: 1 }`
* `{ deliveryId: 1 }`
* `{ raisedBy: 1 }`
* `{ status: 1 }`
* `{ deliveryId: 1, status: 1 }`
* `{ raisedBy: 1, createdAt: -1 }`
* `{ status: 1, createdAt: -1 }`
* unique sparse `{ disputeId: 1 }`

---

### `DriverProfile`

**File:** `src/models/DriverProfile.ts`

**Purpose:** Driver reputation, rating, suspension and vehicle profile.

**Key fields:**

* `userId: ObjectId -> User`
* `reputationPoints: number`
* `tier: ReputationTier`
* `totalDeliveries: number`
* `completedDeliveries: number`
* `rating: number`
* `delayedDeliveries: number`
* `cancelledDeliveries: number`
* `isSuspended: boolean`
* `suspendedUntil?: Date`
* `suspensionReason?: string`
* `lastRatingUpdate?: Date`
* `vehicleDetails?: object`
* `isDeleted: boolean`
* `deletedAt?: Date`
* `deletedBy?: string`

**Indexes:**

* unique `userId`
* `{ reputationPoints: -1 }`
* `{ isSuspended: 1, suspendedUntil: 1 }`
* `{ userId: 1, isDeleted: 1 }`

**Methods:** `softDelete`, `restore`, `applySuspension`, `liftSuspension`.

---

### `DriverLocation`

**File:** `src/models/DriverLocation.ts`

**Purpose:** Stores one current location record per driver for proximity searches.

**Key fields:**

* `driverId: ObjectId -> User`
* `location: GeoJSON Point`
* `isAvailable: boolean`
* `status: online | offline | on_delivery`
* `heading?: number`
* `speed?: number`
* `accuracy?: number`
* `currentDeliveryId?: ObjectId -> Delivery`
* `recordedAt: Date`
* `expiresAt: Date`
* `createdAt`, `updatedAt`

**Indexes:**

* unique `driverId`
* `{ location: "2dsphere" }`
* `{ isAvailable: 1, status: 1, location: "2dsphere" }`
* TTL `{ expiresAt: 1 }` with `expireAfterSeconds: 0`

**Virtuals/methods:** `toLatLng`, static `toGeoPoint`.

The compound geospatial index is the primary hot-query index for available-driver proximity searches.

---

### `LocationUpdate`

**File:** `src/models/LocationUpdate.ts`

**Purpose:** Append-only driver location history.

**Key fields:**

* `driverId: ObjectId`
* `deliveryId?: ObjectId`
* `coordinates: { lat, lng }`
* `capturedAt: Date`
* `isOfflineSync: boolean`
* `status: pending | processed | failed`
* `errorMessage?: string`
* `createdAt`, `updatedAt`

**Indexes:**

* `{ driverId: 1 }`
* `{ deliveryId: 1 }`
* `{ capturedAt: 1 }`
* `{ status: 1 }`
* `{ driverId: 1, status: 1, capturedAt: 1 }`
* `{ deliveryId: 1, capturedAt: 1 }`

---

### `EventLog`

**File:** `src/models/EventLog.ts`

**Purpose:** Durable Soroban/event processing and deduplication state.

**Key fields:**

* `eventType`
* `transactionHash`
* `ledgerSequence`
* `contractId`
* `eventData`
* `processedAt`
* `status: pending | processed | failed`
* `errorMessage`
* `createdAt`, `updatedAt`

**Indexes:**

* `{ eventType: 1 }`
* `{ transactionHash: 1 }`
* `{ ledgerSequence: 1 }`
* `{ contractId: 1 }`
* `{ status: 1 }`
* unique `{ transactionHash: 1, eventType: 1 }`
* `{ status: 1, createdAt: 1 }`
* `{ ledgerSequence: 1, eventType: 1 }`

The unique transaction/event index is critical for event deduplication.

---

### `Evidence`

**File:** `src/models/Evidence.ts`

**Purpose:** Persisted metadata for dispute evidence files.

**Key fields:**

* `disputeId: ObjectId`
* `uploadedBy: ObjectId -> User`
* `storageDriver: local | s3`
* `storageKey: string`
* `url: string`
* `originalName: string`
* `mimeType: string`
* `sizeBytes: number`
* `createdAt`, `updatedAt`

**Indexes:**

* `{ disputeId: 1 }`
* `{ disputeId: 1, createdAt: -1 }`

---

### `Fleet`

**File:** `src/models/Fleet.ts`

**Purpose:** Fleet/business ownership, members and treasury configuration.

**Key fields:**

* `name`
* `treasuryAddress`
* `ownerId: ObjectId -> User`
* `members[]` with `userId`, `role`, `joinedAt`
* `businessMetadata`
* `isActive`
* `drivers[]`
* `createdAt`, `updatedAt`

**Member roles:**

`admin`, `driver`, `viewer`.

**Indexes:**

* `{ isActive: 1 }`
* `{ ownerId: 1 }`
* `{ members.userId: 1 }`
* unique `{ treasuryAddress: 1 }`

**Virtual:** `driverIds`.

---

### `FleetInvitation`

**File:** `src/models/FleetInvitation.ts`

**Purpose:** Fleet driver invitation lifecycle.

**Key fields:**

* `fleetId: ObjectId -> Fleet`
* `driverId: ObjectId -> User`
* `invitedBy: ObjectId -> User`
* `status: FleetInvitationStatus`
* `respondedAt?: Date`
* `createdAt`, `updatedAt`

**Indexes:**

* unique partial `{ fleetId: 1, driverId: 1, status: 1 }` when status is `pending`
* `{ driverId: 1 }`

The partial unique index prevents duplicate simultaneous pending invitations.

---

### `Notification`

**File:** `src/models/Notification.ts`

**Purpose:** Persisted push notification delivery result.

**Key fields:**

* `user: ObjectId -> User`
* `event: NotificationEvent`
* `channel: NotificationChannel`
* `title`
* `body`
* `data`
* `status: NotificationStatus`
* `acceptedCount`
* `rejectedCount`
* `failureReason?`
* `delivery?: ObjectId -> Delivery`
* `createdAt`, `updatedAt`

**Indexes:**

* `{ user: 1, createdAt: -1 }`
* `{ delivery: 1, createdAt: -1 }`

---

### `NotificationPreference`

**File:** `src/models/NotificationPreference.ts`

**Purpose:** User push-notification preferences and device registration.

**Key fields:**

* `user: ObjectId -> User`
* `pushEnabled`
* `enabledEvents`
* `devices[]`
* `createdAt`, `updatedAt`

**Enums:**

Notification events:

`delivery.pending`, `delivery.assigned`, `delivery.in_progress`, `delivery.completed`, `delivery.cancelled`.

Channel:

`push`.

Device platforms:

`ios`, `android`, `web`.

**Indexes:**

* unique `user`
* unique `{ devices.token: 1 }`

---

### `IdempotencyRecord`

**File:** `src/models/IdempotencyRecord.ts`

**Purpose:** Persist idempotent request state and replay responses.

**Key fields:**

* `key`
* `endpoint`
* `status: processing | completed | failed`
* `responseStatus?`
* `responseBody?`
* `expiresAt`
* `createdAt`, `updatedAt`

**Indexes:**

* unique `{ key: 1, endpoint: 1 }`
* TTL `{ expiresAt: 1 }` with `expireAfterSeconds: 0`

The composite unique index scopes an idempotency key to its endpoint.

---

### `DlqEntry`

**File:** `src/models/DlqEntry.ts`

**Purpose:** Dead-letter queue entries for failed transaction processing.

**Key fields:**

* `payload`
* `errorReason`
* `retryCount`
* `status: pending | retried | resolved`
* `createdAt`, `updatedAt`

**Indexes:** No explicit custom index is currently defined.

The service lists entries newest-first using `createdAt`.

---

### `IndexerAlert`

**File:** `src/models/IndexerAlert.ts`

**Purpose:** Durable record of escrow-indexer lag threshold breaches.

**Key fields:**

* `network`
* `processedLedger`
* `networkLedger`
* `lagLedgers`
* `thresholdLedgers`
* `webhookConfigured`
* `webhookNotified`
* `webhookError?`
* `createdAt`, `updatedAt`

**Indexes:**

* `{ network: 1 }`
* `{ network: 1, createdAt: -1 }`

---

### `IndexerStatus`

**File:** `src/models/IndexerStatus.ts`

**Purpose:** Durable per-network indexer checkpoint.

**Key fields:**

* `network`
* `lastProcessedLedger`
* `lastProcessedAt`
* `createdAt`, `updatedAt`

**Indexes:**

* unique `{ network: 1 }`

---

### `DeliveryFeeQuote`

**File:** `src/models/DeliveryFeeQuote.ts`

**Purpose:** Stores calculated delivery pricing quotes with expiration.

**Key fields:**

* `pricingRule: ObjectId -> PricingRule`
* `pickup`
* `dropoff`
* `distanceKm`
* `normalDurationMinutes`
* `trafficDurationMinutes`
* `rainMillimeters`
* `fee`
* `assetCode`
* `expiresAt`
* `createdAt`

**Indexes:**

* TTL `{ expiresAt: 1 }` with `expireAfterSeconds: 0`

---

### `PricingRule`

**File:** `src/models/PricingRule.ts`

**Purpose:** Operations-managed delivery pricing configuration.

**Key fields:**

* `name`
* `active`
* `assetCode`
* `baseFee`
* `distanceRate`
* `trafficMinuteRate`
* `rainMillimeterRate`
* `minimumFee`
* `validityMinutes`
* `createdAt`, `updatedAt`

All monetary/rate values are constrained to non-negative values.

**Indexes:**

* unique partial `{ active: 1 }` where `active === true`

This guarantees at most one active pricing rule.

---

### `WebhookSubscription`

**File:** `src/models/WebhookSubscription.ts`

**Purpose:** Merchant webhook endpoint registrations.

**Key fields:**

* `merchantId: ObjectId -> User`
* `url`
* `secret`
* `events`
* `isActive`
* `description?`
* `createdAt`, `updatedAt`

**Webhook events:**

`delivery.pending`, `delivery.funded`, `delivery.assigned`, `delivery.in_progress`, `delivery.completed`, `delivery.cancelled`.

**Indexes:**

* `{ merchantId: 1 }`
* `{ merchantId: 1, isActive: 1 }`

`secret` is excluded from normal queries.

---

### `WebhookDeliveryAttempt`

**File:** `src/models/WebhookDeliveryAttempt.ts`

**Purpose:** Durable webhook dispatch and retry state.

**Key fields:**

* `webhook: ObjectId -> WebhookSubscription`
* `merchantId: ObjectId -> User`
* `event`
* `delivery: ObjectId -> Delivery`
* `payload`
* `status: pending | success | failed | exhausted`
* `attempts`
* `maxAttempts`
* `lastAttemptAt?`
* `lastStatusCode?`
* `lastError?`
* `nextRetryAt?`
* `createdAt`, `updatedAt`

**Indexes:**

* `{ webhook: 1 }`
* `{ delivery: 1 }`
* `{ status: 1, nextRetryAt: 1 }`

The retry index supports bounded scans for due webhook attempts.

---

### `AuditLog`

**File:** `src/models/AuditLog.ts`

**Purpose:** Records administrative and security-sensitive actions.

**Key fields:**

* `action`
* `actor?: ObjectId -> User`
* `targetType?`
* `targetId?`
* `description?`
* `meta?`
* `createdAt`

**Indexes:** No explicit custom index is currently defined.

---

### `ChatMessage`

**File:** `src/models/ChatMessage.ts`

**Purpose:** Stores socket/chat messages.

**Key fields:**

* `content`
* `sender?`
* `createdAt`

**Indexes:**

* `{ createdAt: -1 }`

The index supports recent-message queries sorted newest-first.

---

### Legacy `Delivery`

**File:** `src/models/deliveryModel.ts`

**Purpose:** Legacy delivery schema retained for backward compatibility.

**Model name:** `DeliveryLegacy`.

**Key fields:**

* `customerName`
* `pickupLocation`
* `dropoffLocation`
* `packageDetails`
* `status`
* `assignedDriver?`
* `createdAt`
* `updatedAt`

**Legacy status enum:**

`pending`, `assigned`, `picked_up`, `in_transit`, `delivered`.

**Indexes:**

* `{ status: 1 }`
* `{ assignedDriver: 1 }`

## Hot Query Reference

| Query                          | Important index                                       |
| ------------------------------ | ----------------------------------------------------- |
| Available driver proximity     | `{ isAvailable: 1, status: 1, location: "2dsphere" }` |
| Driver current location lookup | unique `driverId`                                     |
| Delivery listing by status     | `{ status: 1, createdAt: -1 }`                        |
| Delivery listing by driver     | `{ driver: 1, createdAt: -1 }`                        |
| Escrow by delivery             | unique `delivery`                                     |
| Escrow by contract             | sparse unique `contractId`                            |
| Event deduplication            | unique `{ transactionHash: 1, eventType: 1 }`         |
| Idempotency                    | unique `{ key: 1, endpoint: 1 }`                      |
| Webhook retry queue            | `{ status: 1, nextRetryAt: 1 }`                       |
| Driver location history        | `{ driverId: 1, status: 1, capturedAt: 1 }`           |
| Notification history           | `{ user: 1, createdAt: -1 }`                          |
| Dispute listing                | `{ status: 1, createdAt: -1 }`                        |
| Expiring fee quotes            | TTL `{ expiresAt: 1 }`                                |
| Expiring idempotency records   | TTL `{ expiresAt: 1 }`                                |
| Stale driver locations         | TTL `{ expiresAt: 1 }`                                |

## Known Dual-Delivery-Model Conflict

The repository contains two delivery schemas:

```text
src/models/Delivery.ts
src/models/deliveryModel.ts
```

`Delivery.ts` is the primary delivery implementation and uses the `Delivery` model name.

`deliveryModel.ts` is legacy and registers the separate `DeliveryLegacy` model.

The two schemas have different fields and status enums and must not be treated as interchangeable.

New delivery functionality should use the primary `Delivery.ts` model unless a legacy compatibility path explicitly requires `deliveryModel.ts`.

Any future removal of `deliveryModel.ts` should first identify and migrate all remaining imports and callers.
