# Resilience and Circuit-Breaker Operations Guide

## Overview

SwiftChain protects external dependencies with circuit breakers, retries, and degraded-mode fallbacks.

The primary protected dependencies are:

* Soroban RPC connectivity and ledger operations.
* Soroban transaction-building RPC operations.
* Google Maps routing.
* Redis-backed idempotency storage.

Circuit-breaker runtime state is exposed through:

```text
GET /api/v1/health/circuit-breakers
```

The repository currently exposes a status endpoint only. A `POST /api/v1/health/circuit-breakers/:name/reset` endpoint is **not currently implemented**.

---

## Circuit Breakers

### `soroban-rpc-*`

**Implementation:** `src/blockchain/soroban.service.ts`

`SorobanService` creates a named circuit breaker for Soroban RPC calls. The name is generated as:

```text
soroban-rpc-1
soroban-rpc-2
...
```

The singleton service normally creates the first instance.

Protected operations include:

* `getHealth`
* `getLatestLedger`
* `getNetwork`

Each protected call uses retry handling before the circuit-breaker layer.

### `soroban-rpc-tx`

**Implementation:** `src/services/transactionService.ts`

This dedicated breaker protects RPC operations used to build escrow-lock transactions.

Protected operations include:

* `getAccount`
* `prepareTransaction`

Keeping transaction RPC operations in a separate breaker prevents transaction-building failures from directly sharing statistics with the Soroban connectivity breaker.

---

## Circuit States

Opossum manages three operational states.

| State      | Meaning                            | Behaviour                                                                  |
| ---------- | ---------------------------------- | -------------------------------------------------------------------------- |
| `closed`   | Normal operation                   | Calls are allowed through normally.                                        |
| `open`     | Dependency is considered unhealthy | Calls are short-circuited instead of repeatedly contacting the dependency. |
| `halfOpen` | Recovery probe                     | A test call is permitted to determine whether the dependency recovered.    |

The transition cycle is:

```text
CLOSED
  │
  │ failure rate exceeds configured threshold
  ▼
OPEN
  │
  │ reset timeout expires
  ▼
HALF-OPEN
  │
  ├── successful probe ──> CLOSED
  │
  └── failed probe ──────> OPEN
```

---

## Circuit-Breaker Configuration

The following environment variables control Soroban breakers:

| Variable                                | Default | Purpose                                          |
| --------------------------------------- | ------: | ------------------------------------------------ |
| `CB_SOROBAN_ERROR_THRESHOLD_PERCENTAGE` |    `50` | Failure percentage required to open the circuit. |
| `CB_SOROBAN_ROLLING_WINDOW_MS`          | `30000` | Rolling statistics window.                       |
| `CB_SOROBAN_RESET_TIMEOUT_MS`           | `60000` | Time spent open before a half-open probe.        |
| `CB_SOROBAN_VOLUME_THRESHOLD`           |     `5` | Minimum calls before the breaker can trip.       |
| `CB_SOROBAN_TIMEOUT_MS`                 | `10000` | Maximum duration for a protected call.           |

These values are consumed by `src/utils/circuitBreaker.ts`.

### Production tuning baseline

A reasonable production baseline is:

```env
CB_SOROBAN_ERROR_THRESHOLD_PERCENTAGE=50
CB_SOROBAN_ROLLING_WINDOW_MS=30000
CB_SOROBAN_RESET_TIMEOUT_MS=60000
CB_SOROBAN_VOLUME_THRESHOLD=5
CB_SOROBAN_TIMEOUT_MS=10000
```

Tune these values according to observed RPC latency, traffic volume, provider reliability, and acceptable degraded-mode duration.

Avoid using a very low volume threshold on low-traffic deployments because a small number of transient failures can otherwise trip the circuit prematurely.

---

## Circuit-Breaker Logs

The circuit-breaker implementation emits structured log markers that can be searched during incident investigation.

### State transitions

```text
[CircuitBreaker] "<name>" OPENED
[CircuitBreaker] "<name>" HALF-OPEN
[CircuitBreaker] "<name>" CLOSED
```

### Failure signals

```text
[CircuitBreaker] "<name>" call failed
[CircuitBreaker] "<name>" call timed out
[CircuitBreaker] "<name>" call rejected — circuit is OPEN
[CircuitBreaker] "<name>" fallback triggered
```

### Successful calls

```text
[CircuitBreaker] "<name>" call succeeded
```

Soroban-specific logs include:

```text
[Soroban] Connectivity OK
[Soroban] Connectivity FAILED
[Soroban] Connectivity check degraded — circuit is OPEN
```

Transaction-building failures use:

```text
[TransactionService] ...
```

---

## Soroban RPC Retry and Degraded Mode

Soroban RPC calls have a retry layer before the circuit breaker.

Relevant variables:

```env
SOROBAN_RPC_MAX_RETRIES=3
SOROBAN_RPC_RETRY_BASE_MS=250
SOROBAN_RPC_RETRY_MAX_MS=8000
SOROBAN_RPC_TIMEOUT_MS=10000
```

The operational sequence is:

```text
API request
   │
   ▼
Soroban service
   │
   ▼
Retry with exponential backoff
   │
   ├── success ───────────────> return result
   │
   └── repeated failure
            │
            ▼
       Circuit breaker
            │
       ┌────┴────┐
       │         │
     CLOSED     OPEN
       │         │
       ▼         ▼
    failure   degraded result /
               short circuit
```

When the Soroban breaker is open, `SorobanService` can return a degraded response:

```ts
{
  degraded: true,
  reason: "Soroban RPC circuit is OPEN — the node is temporarily unreachable..."
}
```

Connectivity checks return a degraded/unhealthy result rather than blocking indefinitely.

Transaction-building operations surface Soroban availability problems as HTTP `503 Service Unavailable`.

---

## Routing Fallback

**Implementation:** `src/services/routingService.ts`

The routing chain is:

```text
Google Maps API key configured?
        │
   ┌────┴────┐
   │         │
  yes        no
   │         │
   ▼         ▼
Google      Haversine
Maps        calculation
   │
   │ API failure
   ▼
error response
```

When `GOOGLE_MAPS_API_KEY` is absent, the service immediately uses the built-in Haversine calculation.

The Haversine implementation normalizes longitude differences into the `[-180, 180]` range, making distance calculations safe for anti-meridian crossings.

> Note: the current implementation does not automatically fall back to Haversine after a Google Maps request throws. A Google Maps API failure is logged and surfaced as a failed ETA calculation.

---

## Redis → MongoDB Idempotency Fallback

**Implementation:** `src/services/idempotency.service.ts`

Redis is the preferred idempotency store.

MongoDB is used when:

* Redis is not available.
* Redis GET fails.
* Redis SET/SETEX fails.
* Redis NX acquisition fails.

The normal flow is:

```text
Request
  │
  ▼
Redis
  │
  ├── available ──> use Redis
  │
  └── unavailable/failure
          │
          ▼
       MongoDB
```

The MongoDB collection uses idempotency records with an expiry timestamp/TTL mechanism.

The service also performs MongoDB shadow writes when Redis is authoritative.

### Consistency trade-off

Redis provides the fast primary path, while MongoDB provides persistence and fallback behaviour.

When Redis is unavailable:

* Requests can continue using MongoDB.
* Latency may increase.
* MongoDB becomes the active coordination store.
* Cross-instance behaviour depends on MongoDB uniqueness/atomic operations.
* Redis-only cached state may not be immediately available after recovery.

Operators should investigate Redis failures even when MongoDB fallback keeps the API operational.

Useful log markers include:

```text
[IdempotencyService] Redis GET error, falling back to MongoDB
[IdempotencyService] Redis SETEX error, falling back to MongoDB
[IdempotencyService] Redis NX error, falling back to MongoDB
[IdempotencyService] Failed to persist completed record in both stores
```

---

## Circuit-Breaker Health Endpoint

Endpoint:

```http
GET /api/v1/health/circuit-breakers
```

The response includes:

* Breaker name.
* Current state.
* Total registered breakers.
* Number of closed breakers.
* Number of open breakers.
* Number of half-open breakers.
* Rolling failure statistics.
* Success count.
* Reject count.
* Timeout count.
* Fallback count.
* Fire count.
* Calculated error percentage.

HTTP status:

```text
200 — all breakers closed
206 — one or more breakers open or half-open
```

Example monitoring request:

```bash
curl http://localhost:3000/api/v1/health/circuit-breakers
```

---

## Reset Procedure

There is currently **no implemented reset endpoint**.

The intended recovery mechanism is automatic:

1. The breaker opens after exceeding its configured failure threshold.
2. The breaker remains open for `CB_SOROBAN_RESET_TIMEOUT_MS`.
3. Opossum transitions the breaker to half-open.
4. A probe call tests the dependency.
5. Successful recovery closes the circuit.
6. A failed probe reopens the circuit.

For an emergency reset, restart the application process so the in-memory breaker registry is recreated.

Do not treat a process restart as a substitute for resolving the underlying dependency failure.

---

## Monitoring Guidance

Monitor:

* `GET /api/v1/health/circuit-breakers`.
* HTTP `206` responses from the circuit-breaker health endpoint.
* Repeated `OPENED` and `HALF-OPEN` transitions.
* Increasing timeout/reject counts.
* Soroban connectivity failures.
* Redis fallback warnings.
* Google Maps routing failures.
* Elevated `503` responses from Soroban-dependent endpoints.

### Incident checklist

```text
1. Check /api/v1/health/circuit-breakers.
2. Identify the breaker in OPEN or HALF-OPEN state.
3. Check corresponding [CircuitBreaker] log markers.
4. Check dependency-specific logs.
5. Verify dependency/network availability.
6. Check configured timeout and threshold values.
7. Allow automatic half-open recovery.
8. Restart the service only when an immediate in-memory breaker reset is required.
```
