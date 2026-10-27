# Health, observability, and metrics reference

This runbook describes the operational endpoints and logging behavior currently implemented by SwiftChain Backend. Replace the example host and all sample values with the deployment's real values. JSON examples are illustrative, not live responses.

## Endpoint inventory

Use the configured API base URL, for example https://api.example.com/api.

| Endpoint | Access | Healthy / success response | Purpose and cautions |
| --- | --- | --- | --- |
| GET /api/v1/health | No route-level authentication | 200 when MongoDB and Stellar RPC are healthy; 503 when either is degraded | Readiness-style dependency check. It checks MongoDB and Stellar RPC, not Redis. |
| GET /api/v1/health/circuit-breakers | No route-level authentication | 200 when all registered breakers are closed; 206 if any is open or half-open | Runtime state and rolling failure statistics for registered circuit breakers. |
| GET /api/v1/socket-metrics | No route-level authentication | 200 | Process-local Socket.IO counts, latency percentiles, memory snapshot, and sample timestamp. Restrict access at the network boundary. |
| GET /api/v1/stellar/health | No route-level authentication | 200 when the configured RPC node responds; 503 when unhealthy | Live Stellar/Soroban RPC connectivity check. |
| GET /api/v1/stellar/network | No route-level authentication | 200 on success | Raw network information returned by Soroban RPC, including its network passphrase and protocol version. |
| GET /api/v1/stellar/ledger/latest | No route-level authentication | 200 on success | Latest ledger sequence reported by Soroban RPC. |
| GET /api/v1/monitor/indexer-lag | Admin JWT required | 200 with a lag snapshot, including when the threshold is breached | Runs a live check and may write an alert and call a webhook. Do not use as a high-frequency liveness probe. |
| GET /api/v1/monitor/indexer-lag/alerts?limit=20 | Admin JWT required | 200 | Lists the newest persisted indexer-lag alert records. Limit is bounded to 1–100; default is 20. |

The health, circuit-breaker, Socket.IO, and Stellar endpoints are not protected by route-level authentication in the current implementation. Put them behind an internal network, API gateway, firewall, or other approved access boundary. Do not assume that an endpoint is private merely because it is intended for operators.

The monitor routes use the existing authenticate middleware followed by requireRole(admin). A missing/invalid token should be treated as an authentication failure, and a non-admin role should receive 403.

## Health endpoint

GET /api/v1/health checks two required dependencies in parallel:

- MongoDB: Mongoose connection state and a live ping command.
- Stellar/Soroban RPC: connectivity through the existing Soroban service, which applies its retry and circuit-breaker behavior.

Example healthy response:

    {
      "success": true,
      "data": {
        "status": "healthy",
        "services": {
          "mongodb": {
            "status": "healthy",
            "readyState": 1,
            "readyStateLabel": "connected"
          },
          "stellarRpc": {
            "status": "healthy",
            "network": "testnet",
            "latestLedger": 123456,
            "latencyMs": 42,
            "checkedAt": "2026-10-27T10:00:00.000Z"
          }
        },
        "timestamp": "2026-10-27T10:00:00.000Z",
        "uptime": 86400
      },
      "error": null,
      "message": "All services are healthy"
    }

When either dependency is unhealthy, the endpoint returns HTTP 503 with success=false and a populated data object whose overall status is degraded. The per-service result identifies the unhealthy dependency. The error field is intentionally null in this envelope; inspect data.services.<service>.error for the diagnostic message.

Use this endpoint for a readiness/dependency check at a moderate interval. It performs network/database work, so do not poll it at extremely high frequency. It does not report Redis health or MongoDB pool pressure in the current implementation.

## Circuit-breaker endpoint

GET /api/v1/health/circuit-breakers returns every registered circuit breaker and a summary. It returns HTTP 200 if all breakers are closed and HTTP 206 if at least one is open or half-open.

Example response:

    {
      "success": true,
      "data": {
        "breakers": [
          {
            "name": "soroban-rpc-1",
            "state": "closed",
            "stats": {
              "failures": 0,
              "successes": 48,
              "rejects": 0,
              "timeouts": 0,
              "fallbacks": 0,
              "fires": 48,
              "percentError": 0
            }
          }
        ],
        "summary": {
          "total": 1,
          "closed": 1,
          "open": 0,
          "halfOpen": 0
        }
      },
      "error": null,
      "message": "Circuit breaker status retrieved"
    }

The actual breaker names and count depend on which services have been initialized in that process. The registry is in memory, so the endpoint describes the current process, not a fleet-wide aggregate. Combine results from all instances in your monitoring system.

The Soroban circuit breaker uses environment-configured thresholds. The effective defaults in the current schema are a 50% error threshold, a 10-second rolling window, a 30-second reset timeout, a volume threshold of 5 calls, and a 10-second call timeout. Confirm the deployed environment values before setting alerts.

## Socket.IO metrics endpoint

GET /api/v1/socket-metrics returns a JSON snapshot; it is not itself Prometheus text exposition format.

Example response:

    {
      "success": true,
      "data": {
        "connectedSockets": 12,
        "totalConnections": 950,
        "totalDisconnections": 938,
        "messagesProcessed": 4200,
        "messageLatencyMs": {
          "p50": 8,
          "p95": 35,
          "p99": 80
        },
        "memoryUsageBytes": {
          "heapUsedMB": 110.2,
          "heapTotalMB": 180.5,
          "rssMB": 240.1,
          "externalMB": 4.8
        },
        "timestamp": "2026-10-27T10:00:00.000Z"
      },
      "error": null,
      "message": "Socket.IO metrics retrieved"
    }

Operational notes:

- connectedSockets is the current in-process connection count.
- totalConnections, totalDisconnections, and messagesProcessed are cumulative since that process started.
- messageLatencyMs contains p50, p95, and p99 values in milliseconds, calculated from a rolling window of up to 10,000 samples.
- The legacy field name memoryUsageBytes contains subfields expressed in megabytes (MB); use the subfield names rather than treating those values as bytes.
- Counters and the latency sample window are process-local and reset when the process restarts. Aggregate across instances before drawing fleet-wide conclusions.
- Because the route is not authenticated, restrict it to trusted networks.

## Prometheus exposition endpoint (separate metrics implementation)

The dedicated text exposition endpoint is being implemented separately under issue #248. After that implementation is merged, it is opt-in and disabled unless ENABLE_METRICS=true. It exposes GET /metrics and GET /api/v1/metrics, requires a valid admin Bearer JWT, and returns text/plain Prometheus exposition. Keep it on a trusted network and configure the scraper to supply credentials securely.

The collector's metric families include:

- swiftchain_http_requests_total and swiftchain_http_request_duration_seconds for request volume and latency histograms.
- swiftchain_process_uptime_seconds, swiftchain_process_resident_memory_bytes, swiftchain_process_heap_used_bytes, and swiftchain_process_heap_total_bytes.
- swiftchain_mongodb_connection_ready, swiftchain_mongodb_pool_stats_available, and swiftchain_mongodb_pool_connections with total/available/in-use states.
- swiftchain_redis_healthy for a Redis PING result.
- swiftchain_circuit_breaker_open for each registered breaker.
- swiftchain_indexer_lag_available and swiftchain_indexer_lag_ledgers.
- swiftchain_socket_* gauges adapted from the existing Socket.IO snapshot.

Do not configure an alert on Mongo pool values unless swiftchain_mongodb_pool_stats_available is 1. MongoDB pool fields are read from the installed driver topology and may not be available on every driver version. The collector's indexer snapshot is intended to avoid the alert-writing side effects of the admin on-demand monitor endpoint.

## Stellar/Soroban endpoints

### GET /api/v1/stellar/health

Performs a live connectivity check against the configured RPC node. A healthy response uses the standard success envelope and includes connectivity information such as the configured network, latest ledger, round-trip latency, and check time. An unhealthy RPC result returns HTTP 503.

Example healthy response:

    {
      "success": true,
      "data": {
        "connected": true,
        "network": "testnet",
        "latestLedger": 123456,
        "latencyMs": 42,
        "checkedAt": "2026-10-27T10:00:00.000Z"
      },
      "error": null,
      "message": "Stellar RPC node is healthy"
    }

### GET /api/v1/stellar/network

Returns the raw getNetwork response from Soroban RPC, including network passphrase and protocol version. The exact values depend on the selected RPC network and deployed protocol.

Example shape:

    {
      "success": true,
      "data": {
        "friendbotUrl": "https://friendbot.example.test",
        "passphrase": "Test SDF Network ; September 2015",
        "protocolVersion": 22
      },
      "error": null,
      "message": "Network info retrieved successfully"
    }

### GET /api/v1/stellar/ledger/latest

Returns the most recent ledger sequence:

    {
      "success": true,
      "data": {
        "latestLedger": 123456
      },
      "error": null,
      "message": "Latest ledger retrieved successfully"
    }

These routes call the live RPC service. A transient RPC outage, retry, timeout, or open circuit may affect latency or return a degraded fallback object even when the HTTP response is 200. Check the response shape and cross-reference GET /api/v1/stellar/health and the circuit-breaker endpoint. Do not interpret a successful HTTP response from a cached or unrelated dependency as proof that every Stellar operation is healthy.

## Indexer lag and alert history

### GET /api/v1/monitor/indexer-lag

This admin-only endpoint compares the persisted IndexerStatus checkpoint for the configured network with the current ledger reported by Soroban RPC.

Example response:

    {
      "success": true,
      "data": {
        "network": "testnet",
        "processedLedger": 123300,
        "networkLedger": 123456,
        "lagLedgers": 156,
        "thresholdLedgers": 100,
        "breached": true,
        "checkedAt": "2026-10-27T10:00:00.000Z"
      },
      "error": null,
      "message": "Indexer lag status retrieved successfully"
    }

The endpoint currently returns HTTP 200 even when breached is true. Monitor the data.breached field or compare lagLedgers with thresholdLedgers; do not rely on the HTTP status alone. If Soroban RPC returns a degraded result, the on-demand check falls back to the processed checkpoint as the network-ledger value, which can make lag appear to be zero. Cross-check the Stellar health and circuit-breaker endpoints before interpreting that zero as healthy progress.

An on-demand check can create an IndexerStatus checkpoint if one does not exist. If the lag exceeds the configured threshold, it logs a critical event, writes an IndexerAlert record, and attempts the configured webhook. Prefer the background monitor and persisted alert history for normal operations rather than calling this endpoint on every scrape.

### GET /api/v1/monitor/indexer-lag/alerts?limit=20

Returns recent persisted alerts, newest first.

Example response:

    {
      "success": true,
      "data": {
        "alerts": [
          {
            "network": "testnet",
            "processedLedger": 123300,
            "networkLedger": 123456,
            "lagLedgers": 156,
            "thresholdLedgers": 100,
            "webhookConfigured": true,
            "webhookNotified": true,
            "createdAt": "2026-10-27T10:00:00.000Z"
          }
        ],
        "count": 1
      },
      "error": null,
      "message": "Indexer lag alerts retrieved successfully"
    }

The response includes stored webhook outcome fields; the precise document may also contain webhookError when delivery failed. The endpoint clamps the requested limit to 1–100, defaulting to 20.

### Indexer lag webhook configuration

Configure INDEXER_LAG_WEBHOOK_URL to an HTTPS receiver that accepts POST requests with a JSON body. An empty value disables webhook delivery. The background monitor runs every INDEXER_LAG_CHECK_INTERVAL_MS (default 60,000 ms) and uses INDEXER_LAG_ALERT_THRESHOLD (default 100 ledgers). The alert condition is lagLedgers greater than the threshold, not greater-than-or-equal.

The payload includes event=indexer_lag_alert plus network, processedLedger, networkLedger, lagLedgers, thresholdLedgers, breached, and checkedAt. The receiver should acknowledge successful delivery with a 2xx status. The current implementation does not add a signature or authorization header, a request timeout, or a dedicated retry/backoff mechanism for failed indexer-alert webhook deliveries. A slow receiver can delay the current monitor cycle, and a later cycle may attempt another notification while the threshold remains breached. Use a trusted HTTPS endpoint, restrict outbound access where possible, and avoid placing secrets in the webhook URL. Failed notification details are recorded in the IndexerAlert webhookError field and in logs.

The persisted IndexerAlert record is the audit trail: it records the network and ledger gap, the threshold, whether a webhook was configured, whether notification succeeded, and an error message when delivery failed. Retain and monitor these records independently of rotating log files.

## Winston log format and levels

All application code should use the shared logger from src/config/logger.ts. Its PII-masking format runs before console and file transports.

- NODE_ENV=development: colored, human-readable, single-line console output with timestamp, level, message, and compact structured metadata.
- Other environments, including production: structured JSON console output with timestamp, level, message, and metadata. Error records can include a stack trace after masking.
- File output is always structured JSON, even in development.
- Severity levels are error, warn, info, http, and debug. LOG_LEVEL defaults to info and controls the minimum level.
- File logging uses daily rotation and size limits. Defaults are LOG_DIR=logs, LOG_MAX_SIZE=20m, LOG_MAX_FILES=14d, LOG_ZIPPED_ARCHIVE=true. LOG_DISABLE_FILE=true disables file transports; file transports are also skipped in tests.
- Logging failures are handled without terminating the process.

Illustrative development line:

    2026-10-27 10:00:00.123 info: GET /api/v1/health - 200 (42ms) {"method":"GET","statusCode":200,"duration":42}

Illustrative production JSON record:

    {
      "timestamp": "2026-10-27T10:00:00.123Z",
      "level": "info",
      "message": "GET /api/v1/health - 200 (42ms)",
      "method": "GET",
      "statusCode": 200,
      "duration": 42
    }

Actual metadata varies by call site. Console colors are for humans; use JSON fields for ingestion and queries in production.

## Request tracking and log correlation

src/middleware/requestLogger.ts logs the HTTP method, original URL, status code, duration, client IP, and user-agent when a response finishes. Responses with status 400 or higher are logged at warn; successful responses are logged at info.

src/middleware/requestTracker.ts maintains an in-flight request counter for graceful shutdown. Once draining begins, it rejects new requests with 503 and Connection: close. It does not currently generate a per-request ID or add a correlation ID to log records.

Until request-ID middleware is added, correlate an access log with application logs using a narrow UTC time window, method, route/URL, status, and relevant domain identifiers that are safe to log. If a reverse proxy generates X-Request-ID, do not assume it is logged by the current requestLogger; the middleware must explicitly capture and log that header before it can be used as a reliable correlation key. Avoid copying full request bodies or credentials into log metadata.

## PII masking behavior

The shared logger masks the message and structured metadata before any transport receives the record. It uses two complementary strategies:

1. Key-based redaction: values under keys matching sensitive patterns such as password, token, secret, authorization, credential, cookie, session ID, signature, private key, seed, OTP, PIN, CVV, or refresh/access token are replaced with [REDACTED]. A small allow-list preserves non-secret metadata such as tokenType, authProvider, authMethod, hasToken, and tokenExpiresAt.
2. Pattern-based masking: recognizable emails are partially masked; JWTs, bearer/basic tokens, PEM private-key blocks, Stellar secret seeds, and embedded connection-string passwords are redacted while the scheme and username remain for diagnostics; E.164-style phone numbers with a + country code, valid payment-card numbers, and Stellar public identifiers are partially masked.

If masking itself fails, the logger replaces the message with a safe placeholder instead of passing through the unmasked record.

Masking is a defense-in-depth layer, not permission to log sensitive data. Unrecognized formats or arbitrary secret query parameters may not be detected. Never put passwords, API keys, access tokens, private keys, or unnecessary personal data in URLs, log messages, or metadata.

## Recommended alert thresholds

Tune these thresholds to the deployment's normal baseline and agreed SLOs. They are starting recommendations, not hard-coded application behavior.

| Signal | Warning | Critical / action |
| --- | --- | --- |
| Indexer lag | Lag above INDEXER_LAG_ALERT_THRESHOLD (default 100 ledgers) for one check | Lag remains above threshold for two monitor intervals, or the gap continues to grow; inspect indexer checkpoint progress, RPC health, and IndexerAlert records |
| Circuit breaker | Any breaker enters half-open or open | Breaker remains open for more than 1 minute or repeatedly reopens; inspect dependency latency, failures, timeouts, and rejects |
| MongoDB connectivity | Health check reports MongoDB unhealthy once | Repeated 503 health responses or sustained connection failures; inspect database availability and pool metrics from the database provider/APM |
| MongoDB pool pressure | Pool utilization above 80% for 5 minutes, if pool metrics are available | Above 95% for 1 minute, queue wait rises, or request latency increases; inspect max pool size and query latency |
| Redis availability | Redis exporter/provider reports a failed ping or reconnecting state | Redis remains unavailable for 1 minute or distributed locking fails; inspect Redis logs, network reachability, and credentials |
| Stellar RPC | Health endpoint reports unhealthy or the breaker is degraded | RPC remains unhealthy for 1 minute, breaker stays open, or latest-ledger reads stop advancing |
| Socket.IO latency | p95 above 100 ms for 5 minutes | p95 above 250 ms for 5 minutes, p99 rises sharply, or disconnects increase alongside latency |
| Process memory | RSS rises steadily across several samples | RSS approaches the container memory limit or restarts/OOM events occur |

The current health endpoint does not include Redis or MongoDB pool utilization. Use your database provider's pool/connection metrics and a Redis exporter or provider health check until a dedicated metrics collector is deployed. The Socket.IO endpoint reports memory and socket latency but is JSON, not Prometheus exposition. The opt-in Prometheus endpoint is tracked separately; do not scrape the JSON socket endpoint as if it were Prometheus text.

## Suggested Grafana or Datadog dashboard

Organize the operational dashboard into these rows:

1. Availability: HTTP health status, MongoDB ready state, Stellar RPC status/latency, current circuit-breaker states, and deployment/restart markers.
2. Indexer: processed ledger, current network ledger, lag in ledgers, threshold, breached state, alert count, webhook configured/notified/error outcomes.
3. Socket.IO: connected sockets, connection/disconnection totals and rates, messages processed, p50/p95/p99 latency, process RSS and heap.
4. Dependencies: MongoDB connections/pool utilization and query latency from provider/APM metrics; Redis ping/availability and latency; Soroban RPC latency, errors, timeouts, and circuit-breaker transitions.
5. Logs: log volume by level, request status and duration, route, dependency errors, indexer-lag alerts, webhook outcomes, and process restarts. Keep PII redaction enabled in every sink.
6. Deployment: release version, instance/pod, region/network, uptime, and changes to feature or environment configuration.

Use consistent filters for environment, service instance, and network. Aggregate process-local Socket.IO counters across instances rather than summing snapshots without distinguishing process restarts. Alert on sustained conditions to reduce noise, but page immediately for repeated critical dependency failures or a rapidly growing indexer lag.

## Operational checklist

- Restrict unauthenticated health, Stellar, circuit-breaker, and Socket.IO endpoints to approved networks.
- Verify the deployed INDEXER_LAG_ALERT_THRESHOLD, INDEXER_LAG_CHECK_INTERVAL_MS, and INDEXER_LAG_WEBHOOK_URL values.
- Confirm the webhook receiver accepts HTTPS POST JSON and has its own access controls.
- Confirm logs are ingested as JSON in production and that rotation/retention meet policy.
- Keep PII masking enabled and avoid credentials in URLs.
- Remember that requestTracker is a drain counter, not a request-ID generator.
- Test alert delivery and recovery in a non-production environment before relying on it for paging.
