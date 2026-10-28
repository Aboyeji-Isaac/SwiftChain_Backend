# Driver Reputation, Leaderboard, and Fleet Metrics

## Overview

This document describes how SwiftChain calculates driver reputation tiers, leaderboard ordering, driver performance metrics, and fleet delivery metrics.

### Source of truth

| Metric                         | Source                                                    |
| ------------------------------ | --------------------------------------------------------- |
| Reputation points              | `src/models/DriverProfile.ts`                             |
| Reputation tier                | `src/interfaces/IDriverProfile.ts` → `computeTier()`      |
| Reputation changes             | `src/indexer/reputationHandlers.ts`                       |
| Leaderboard                    | `src/services/driverService.ts` → `getLeaderboard()`      |
| Fleet metrics                  | `src/services/fleetService.ts` → `getFleetMetrics()`      |
| Driver profile                 | `src/models/DriverProfile.ts`                             |
| Delivery totals                | `src/models/Delivery.ts` / `src/services/fleetService.ts` |
| Driver location / online state | `src/models/DriverLocation.ts`                            |

---

## Reputation Points

`DriverProfile.reputationPoints` is a non-negative numeric score.

The schema prevents the stored value from becoming negative:

```ts
reputationPoints: {
  type: Number,
  default: 0,
  min: [0, 'reputationPoints cannot be negative'],
}
```

Reputation changes are currently applied by the reputation event handlers.

### Reputation increase

`handleReputationIncreased()`:

1. Validates the event.
2. Finds or creates the driver's `DriverProfile`.
3. Adds the event's `points` value to `reputationPoints`.
4. Recalculates the driver's tier.
5. Records the processed ledger sequence.

Formula:

```text
newReputationPoints = currentReputationPoints + event.points
```

Example:

```text
Current points = 85
Reputation event = +20

New points = 85 + 20
           = 105
```

The driver therefore moves from Silver eligibility to the Silver tier if the resulting score is at least 100.

### Reputation slash / decrease

`handleReputationSlashed()` subtracts the supplied event points and floors the result at zero.

Formula:

```text
newReputationPoints = max(0, currentReputationPoints - event.points)
```

Example:

```text
Current points = 120
Slash = 30

New points = max(0, 120 - 30)
           = 90
```

The resulting tier is recalculated after the decrease.

### Important distinction

Completed deliveries, cancellations, delays, and penalties are represented in the driver profile and rating system, but the currently inspected reputation event handler does not directly calculate reputation points from those counters.

The current persisted reputation-point changes come from:

* `reputation_increased`
* `reputation_slashed`

This distinction should be preserved in future documentation unless the business rules are changed to calculate reputation points directly from delivery history.

---

## Reputation Tiers

The tier thresholds are defined in `src/interfaces/IDriverProfile.ts`.

| Tier     | Minimum reputation points |
| -------- | ------------------------: |
| Bronze   |                         0 |
| Silver   |                       100 |
| Gold     |                       500 |
| Platinum |                     1,000 |

Tier calculation:

```text
points >= 1000 → Platinum
points >= 500  → Gold
points >= 100  → Silver
otherwise      → Bronze
```

### Worked promotion examples

#### Bronze → Silver

```text
Starting points: 85
Increase: +20
Final points: 105

105 >= 100
→ Silver
```

#### Silver → Gold

```text
Starting points: 480
Increase: +25
Final points: 505

505 >= 500
→ Gold
```

#### Gold → Platinum

```text
Starting points: 950
Increase: +75
Final points: 1025

1025 >= 1000
→ Platinum
```

#### Tier downgrade after penalty

```text
Starting points: 520
Slash: 40
Final points: 480

480 < 500
→ Silver
```

---

## Driver Performance Rating

The reputation tier is separate from the driver's 0–5 performance rating.

`computeDriverRating()` uses delivery-history rates.

### Late-delivery rate

```text
lateRate =
  delayedDeliveries / completedDeliveries
```

If there are no completed deliveries:

```text
lateRate = 0
```

### Cancellation rate

```text
cancellationRate =
  cancelledDeliveries / totalAssignedDeliveries
```

If there are no assigned deliveries:

```text
cancellationRate = 0
```

### Rating formula

The configured rules are:

```text
MAX_RATING = 5
LATE_DELIVERY_PENALTY = 2
CANCELLATION_PENALTY = 3
```

Therefore:

```text
rating =
  5
  - (lateRate × 2)
  - (cancellationRate × 3)
```

The final value is clamped to `0–5` and rounded to two decimal places.

### Example

```text
Completed deliveries = 20
Delayed deliveries = 2
Assigned deliveries = 25
Cancelled deliveries = 1

lateRate = 2 / 20 = 0.10
cancellationRate = 1 / 25 = 0.04

rating =
  5 - (0.10 × 2) - (0.04 × 3)
= 5 - 0.20 - 0.12
= 4.68
```

A driver must have at least five completed deliveries before the penalty/suspension logic can apply.

---

## Leaderboard

The leaderboard is implemented by:

```text
src/services/driverService.ts
```

`getLeaderboard(page, limit)` queries `DriverProfile` and sorts by:

```ts
.sort({ reputationPoints: -1 })
```

Therefore, the primary ranking input is:

```text
reputationPoints descending
```

The returned rank is calculated from the pagination offset:

```text
rank = ((page - 1) × limit) + index + 1
```

### Leaderboard fields

Each entry contains:

* `rank`
* `userId`
* `reputationPoints`
* `tier`
* `totalDeliveries`
* `completedDeliveries`

### Tie handling

The current leaderboard query specifies only:

```ts
{ reputationPoints: -1 }
```

No secondary sort field is explicitly configured.

Therefore, the application does **not** define a deterministic business tie-breaker for equal reputation scores. MongoDB/database ordering should not be treated as an intentional tie-breaking rule.

If deterministic ties are required later, an explicit secondary field should be added to the query and documented.

### Leaderboard index

`DriverProfile` defines:

```ts
driverProfileSchema.index({ reputationPoints: -1 });
```

This index supports the descending reputation leaderboard query.

---

## Fleet Metrics

Fleet metrics are calculated by:

```text
src/services/fleetService.ts
```

`getFleetMetrics(fleetId, requesterId)` first verifies that:

1. The fleet ID is valid.
2. The fleet exists.
3. The requester owns the fleet.

The service then obtains driver IDs from:

```ts
fleet.drivers
```

The delivery aggregation matches:

```ts
{ driverId: { $in: driverIds } }
```

### `driverCount`

```text
driverCount = number of IDs in fleet.drivers
```

This is a count of the driver's IDs stored in the fleet's legacy `drivers` array.

It is **not** a count of all `Fleet.members`.

### `totalDeliveries`

The aggregation counts every `Delivery` whose `driverId` belongs to the fleet driver IDs:

```text
totalDeliveries =
  count(deliveries where delivery.driverId ∈ fleet.drivers)
```

### `completedDeliveries`

A delivery is counted as completed only when:

```text
delivery.status === "completed"
```

Formula:

```text
completedDeliveries =
  count(matching deliveries with status = completed)
```

### `totalEscrowValue`

Only XLM escrow is included.

The aggregation treats an omitted `escrowAsset.code` as XLM:

```text
asset =
  escrowAsset.code if present
  otherwise XLM
```

Only XLM values contribute:

```text
totalEscrowValue =
  sum(escrowAmount for matching XLM deliveries)
```

Non-XLM assets are excluded.

### Worked fleet example

Assume:

```text
fleet.drivers = [Driver A, Driver B, Driver C]
```

Therefore:

```text
driverCount = 3
```

Suppose the matching deliveries are:

| Delivery | Driver | Status      |  Escrow |
| -------- | ------ | ----------- | ------: |
| D1       | A      | completed   | 100 XLM |
| D2       | A      | in_progress |  50 XLM |
| D3       | B      | completed   |  75 XLM |
| D4       | C      | cancelled   | 40 USDC |

Results:

```text
driverCount = 3

totalDeliveries = 4

completedDeliveries = 2

totalEscrowValue =
  100 + 50 + 75
  = 225 XLM
```

The 40 USDC escrow is excluded from `totalEscrowValue`.

---

## Members and Online Drivers

The current `Fleet` model also contains:

```text
members[]
```

where each member has:

* `userId`
* `role`
* `joinedAt`

The model provides a `driverIds` virtual derived from members whose roles are `driver` or `admin`.

However, `getFleetMetrics()` currently uses the separate:

```text
fleet.drivers
```

array rather than `members` / `driverIds`.

The current `FleetMetrics` response does not expose:

```text
memberCount
onlineDriverCount
```

Driver location data exists separately in:

```text
src/models/DriverLocation.ts
```

Consequently, an "online drivers" metric must not be inferred from the current `getFleetMetrics()` implementation. A future online-driver metric should define its stale-location threshold and query explicitly against `DriverLocation`.

---

## Summary

The current formulas are:

```text
Reputation increase:
points = points + event.points

Reputation decrease:
points = max(0, points - event.points)

Tier:
>= 1000 → Platinum
>= 500  → Gold
>= 100  → Silver
< 100   → Bronze

Late rate:
delayedDeliveries / completedDeliveries

Cancellation rate:
cancelledDeliveries / totalAssignedDeliveries

Performance rating:
5 - (lateRate × 2) - (cancellationRate × 3)

Leaderboard:
reputationPoints DESC

Fleet driver count:
count(fleet.drivers)

Fleet deliveries:
count(Delivery where driverId ∈ fleet.drivers)

Fleet completed deliveries:
count(matching Delivery where status = completed)

Fleet XLM escrow:
sum(matching XLM escrowAmount)
```
