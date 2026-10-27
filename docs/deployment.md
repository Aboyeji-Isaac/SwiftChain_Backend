# Deployment notes

## Prometheus metrics endpoint

The operational metrics endpoint is disabled by default. To enable it in a deployment environment, set the validated variable in the service environment:

    ENABLE_METRICS=true

Restart the application after changing this setting. No database migration is required.

When enabled, the protected endpoint is available at GET /metrics and GET /api/v1/metrics. Both require a valid Bearer JWT for a user with the admin role. Use HTTPS and restrict the endpoint to monitoring infrastructure through a private network, firewall, or trusted authentication proxy. Do not place long-lived admin credentials in source control or commit scrape tokens to a Prometheus configuration file.

A Prometheus-compatible scraper must send an Authorization: Bearer header. Use a secret file or a trusted proxy that can securely rotate credentials. If your deployment cannot supply rotating Bearer tokens safely, keep ENABLE_METRICS=false until an appropriate authentication boundary is configured.

For exported metric names, scrape configuration guidance, and suggested alerts, see [Prometheus metrics](prometheus-metrics.md).

## Operational safety

- Confirm the endpoint returns 404 while ENABLE_METRICS is false.
- Confirm a request without a valid admin token receives an authentication error when metrics are enabled.
- Confirm an authenticated non-admin receives 403.
- Confirm a valid admin token receives Prometheus text exposition with a text/plain content type.
- Monitor scrape latency: the indexer lag collector reads the persisted checkpoint and requests the current network ledger, so scrapes may be slower when the Stellar RPC service is degraded.
