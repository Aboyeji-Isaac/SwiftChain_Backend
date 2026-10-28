# Jobs and Scheduled Cron Reference

## Overview

Background jobs are started from `src/server.ts` when `NODE_ENV !== 'test'`.

The currently registered recurring/background processes are:

1. Auto-assignment job.
2. Escrow monitor job.
3. Webhook retry job.
4. Driver rating job.
5. Event poller stub.
6. Indexer-lag monitor.

The first four are cron-driven jobs. The event poller is currently a stub. The indexer-lag monitor is interval-driven rather than cron-driven.

---

## Job Inventory

| Job                 | Implementation                   | Schedule             | Environment override            | Responsibility                                 |
| ------------------- | -------------------------------- | -------------------- | ------------------------------- | ---------------------------------------------- |
| Auto assignment     | `src/jobs/autoAssignmentJob.ts`  | Every minute         | `AUTO_ASSIGNMENT_CRON`          | Assign available drivers to funded deliveries. |
| Escrow monitor      | `src/jobs/escrowMonitor.ts`      | Every 5 minutes      | `ESCROW_MONITOR_CRON`           | Find and flag expired escrows.                 |
| Webhook retry       | `src/jobs/webhookRetryJob.ts`    | Every minute         | `WEBHOOK_RETRY_CRON`            | Retry due failed webhook attempts.             |
| Driver rating       | `src/jobs/driverRatingJob.ts`    | Hourly               | `DRIVER_RATING_CRON`            | Recalculate driver ratings and penalty state.  |
| Event poller        | `src/services/eventPoller.ts`    | Stub                 | None                            | Placeholder for future real event ingestion.   |
| Indexer lag monitor | `src/services/monitorService.ts` | Every 60s by default | `INDEXER_LAG_CHECK_INTERVAL_MS` | Monitor escrow indexer lag.                    |

---

## Auto Assignment Job

**File:**

```text
src/jobs/autoAssignmentJob.ts
```

**Default schedule:**

```text
* * * * *
```

**Environment variable:**

```env
AUTO_ASSIGNMENT_CRON=* * * * *
```

### Responsibility

The job invokes:

```ts
assignmentService.autoAssignPendingDeliveries()
```

It attempts to assign the nearest available driver to funded deliveries that do not already have a driver.

### Concurrency protection

The job maintains an in-process `isRunning` flag.

If a previous sweep is still running, the next scheduled tick is skipped.

### Log markers

```text
[AutoAssignmentJob] Job scheduled with cron expression
[AutoAssignmentJob] Previous sweep still in progress — skipping this tick.
[AutoAssignmentJob] Sweep complete
[AutoAssignmentJob] Sweep failed
```

### Manual execution

The job exposes:

```ts
runAutoAssignmentSweep()
```

For application-level debugging, invoke the exported function from a controlled Node/TypeScript debugging context rather than starting another scheduler.

---

## Escrow Monitor Job

**File:**

```text
src/jobs/escrowMonitor.ts
```

**Default schedule:**

```text
*/5 * * * *
```

**Environment variable:**

```env
ESCROW_MONITOR_CRON=*/5 * * * *
```

### Responsibility

The job invokes:

```ts
escrowService.scanForExpiredEscrows()
```

It identifies expired escrow locks and flags them for operational handling.

### Concurrency protection

A local `isRunning` flag prevents overlapping scans.

### Log markers

```text
[EscrowMonitor] Job scheduled with cron expression
[EscrowMonitor] Previous scan still in progress — skipping this tick.
[EscrowMonitor] Scan complete
[EscrowMonitor] Scan failed
```

### Manual execution

The exported function is:

```ts
runEscrowExpiryScan()
```

Use the function from an authenticated/controlled application debugging context when manually testing an escrow scan.

---

## Webhook Retry Job

**File:**

```text
src/jobs/webhookRetryJob.ts
```

**Default schedule:**

```text
* * * * *
```

**Environment variable:**

```env
WEBHOOK_RETRY_CRON=* * * * *
```

### Responsibility

The job invokes:

```ts
webhookService.retryDueAttempts()
```

It processes failed webhook attempts whose retry time has become due.

Relevant configuration:

```env
WEBHOOK_MAX_RETRIES=5
WEBHOOK_RETRY_BASE_MS=30000
WEBHOOK_RETRY_MAX_MS=3600000
WEBHOOK_RETRY_BATCH_SIZE=50
WEBHOOK_REQUEST_TIMEOUT_MS=10000
```

### Concurrency protection

An in-process `isRunning` flag prevents overlapping retry sweeps.

### Log markers

```text
[WebhookRetryJob] Job scheduled with cron expression
[WebhookRetryJob] Previous sweep still in progress — skipping this tick.
[WebhookRetryJob] Sweep complete
[WebhookRetryJob] Sweep failed
```

### Manual execution

The exported function is:

```ts
runWebhookRetrySweep()
```

Use the function from a controlled application debugging context.

---

## Driver Rating Job

**File:**

```text
src/jobs/driverRatingJob.ts
```

**Default schedule:**

```text
0 * * * *
```

**Environment variable:**

```env
DRIVER_RATING_CRON=0 * * * *
```

### Responsibility

The job invokes:

```ts
driverRatingService.recalculateAllDriverRatings()
```

It maintains driver rating and penalty state.

### Concurrency protection

An in-process `isRunning` flag prevents overlapping rating sweeps.

### Log markers

```text
[DriverRatingJob] Job scheduled with cron expression
[DriverRatingJob] Previous sweep still in progress — skipping this tick.
[DriverRatingJob] Sweep complete
[DriverRatingJob] Sweep failed
```

### Manual execution

The exported function is:

```ts
runDriverRatingSweep()
```

---

## Event Poller

**File:**

```text
src/services/eventPoller.ts
```

Current implementation:

```text
Event poller started (stub)
Event poller stopped (stub)
```

The event poller is **not a real ingestion worker yet**.

It currently exposes:

```ts
startEventPoller()
stopEventPoller()
```

These functions only emit log messages.

### Operational status

```text
STATUS: STUB
REAL INGESTION: NOT IMPLEMENTED
SCHEDULER: NONE
```

The server starts the stub during normal non-test boot.

It is stopped during graceful shutdown.

---

## Indexer-Lag Monitor

**Implementation:**

```text
src/services/monitorService.ts
```

The monitor starts from `src/server.ts` through:

```ts
startIndexerLagMonitor();
```

Its default interval is:

```env
INDEXER_LAG_CHECK_INTERVAL_MS=60000
```

The monitor uses:

```env
INDEXER_LAG_ALERT_THRESHOLD=100
INDEXER_LAG_CHECK_INTERVAL_MS=60000
INDEXER_LAG_WEBHOOK_URL=
```

The monitor detects lag between the processed ledger and the current network head.

---

## Idempotency Guarantees

The recurring jobs use different safeguards.

| Job             | Overlap protection              | Persistence/idempotency                                                                     |
| --------------- | ------------------------------- | ------------------------------------------------------------------------------------------- |
| Auto assignment | In-process `isRunning` flag     | Assignment service/database state prevents already-assigned work from being treated as new. |
| Escrow monitor  | In-process `isRunning` flag     | Escrow records determine whether work is still eligible.                                    |
| Webhook retry   | In-process `isRunning` flag     | Webhook attempt state and retry scheduling determine due work.                              |
| Driver rating   | In-process `isRunning` flag     | Driver records are recalculated from persisted delivery history.                            |
| Event poller    | None                            | No real ingestion implementation yet.                                                       |
| Indexer monitor | Service-level monitor lifecycle | Persisted alerts are used for detected lag conditions.                                      |

The `isRunning` guards are process-local. They do not by themselves provide distributed locking between multiple application instances.

---

## Graceful Shutdown

The application has a dedicated shutdown service at:

```text
src/services/gracefulShutdownService.ts
```

Background work is stopped before the application drains in-flight requests.

The shutdown service stops:

```text
Event poller
Escrow monitor service
Indexer-lag monitor
```

The legacy/direct server shutdown path also stops the cron jobs explicitly.

Operators should therefore inspect both `src/server.ts` and `src/services/gracefulShutdownService.ts` when changing job lifecycle behaviour.

---

## Debugging Checklist

```text
1. Confirm NODE_ENV is not "test".
2. Check the configured cron environment variable.
3. Search logs for the corresponding [JobName] marker.
4. Check whether the previous execution is still running.
5. Inspect the underlying service invoked by the job.
6. Verify MongoDB/Redis/Soroban dependencies as applicable.
7. Run the exported one-shot function in a controlled debugging context.
8. Confirm the job stops during graceful shutdown.
```

### Useful log searches

```text
[AutoAssignmentJob]
[EscrowMonitor]
[WebhookRetryJob]
[DriverRatingJob]
[Shutdown]
[Database]
[Redis]
[Soroban]
```
