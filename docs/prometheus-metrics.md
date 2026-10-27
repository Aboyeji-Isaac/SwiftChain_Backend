# Prometheus metrics

SwiftChain Backend exposes a Prometheus text exposition endpoint for operational monitoring.

## Enable and access

Set this validated environment variable in .env:

    ENABLE_METRICS=true

The endpoint is disabled by default. When disabled, both paths return 404:

- GET /metrics
- GET /api/v1/metrics

When enabled, both require a valid Bearer JWT for a user with the admin role. Keep the endpoint behind TLS and an operator-only network boundary; do not expose admin credentials in Prometheus scrape configuration. Use a dedicated monitoring identity and rotate its token according to your security policy.

Example request:

    curl -H "Authorization: Bearer $METRICS_ADMIN_TOKEN" http://localhost:3000/metrics

The response uses text/plain; version=0.0.4; charset=utf-8 and can be scraped by Prometheus-compatible collectors.

## Exported metrics

| Metric | Type | Meaning |
| --- | --- | --- |
| swiftchain_http_requests_total | Counter | Completed HTTP requests, labelled by method, Express route template, and status code |
| swiftchain_http_request_duration_seconds | Histogram | Request duration buckets, sum, and count |
| swiftchain_process_uptime_seconds | Gauge | Process uptime |
| swiftchain_process_resident_memory_bytes | Gauge | Resident memory |
| swiftchain_process_heap_used_bytes / swiftchain_process_heap_total_bytes | Gauge | Node.js heap usage |
| swiftchain_mongodb_connection_ready | Gauge | Whether Mongoose is connected |
| swiftchain_mongodb_pool_stats_available | Gauge | Whether the installed MongoDB driver exposes pool statistics |
| swiftchain_mongodb_pool_connections | Gauge | Total, available, and in-use MongoDB pool connections |
| swiftchain_redis_healthy | Gauge | Result of a Redis PING check |
| swiftchain_circuit_breaker_open | Gauge | Circuit-breaker state by registered breaker |
| swiftchain_indexer_lag_available | Gauge | Whether a lag snapshot could be read |
| swiftchain_indexer_lag_ledgers | Gauge | Gap between persisted processed ledger and the live network ledger |
| swiftchain_socket_* | Gauge / counter | Current connection and latency snapshots are gauges; cumulative connection, disconnection, and message totals are counters |

HTTP route labels use Express route templates rather than raw request URLs, preventing user IDs, arbitrary paths, and query values from creating high-cardinality labels. The indexer metric reads the current checkpoint and live ledger without persisting alerts or sending webhooks during a scrape.

MongoDB pool metrics depend on runtime pool fields exposed by the installed MongoDB driver. Check swiftchain_mongodb_pool_stats_available before relying on pool connection values.

## Suggested scrape configuration

Configure your Prometheus-compatible scraper to use the application URL, HTTPS in production, and an authorization mechanism that securely supplies a short-lived admin token. Do not commit tokens or other credentials to prometheus.yml. If your scraper cannot safely rotate a Bearer token, place a trusted authentication proxy in front of the endpoint and restrict direct network access.

## Initial alert guidance

Treat these as starting points and tune them to the service's normal traffic:

- HTTP 5xx ratio remains above 5% for 5 minutes.
- Request p95 latency exceeds the service's agreed SLO for 5 minutes.
- swiftchain_mongodb_connection_ready is 0.
- swiftchain_redis_healthy is 0.
- Any swiftchain_circuit_breaker_open sample is 1.
- swiftchain_indexer_lag_ledgers remains above INDEXER_LAG_ALERT_THRESHOLD.
- MongoDB pool in-use connections remain close to total connections while request latency rises.

All in-memory request counters and socket totals are process-local and reset when that instance restarts. Scrape each instance separately and aggregate in the monitoring backend; do not treat one instance's values as a fleet-wide total. This endpoint exports metrics; it does not configure Prometheus, Grafana, Datadog, alert delivery, or retention automatically.
