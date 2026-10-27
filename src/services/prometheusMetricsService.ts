import mongoose from 'mongoose';
import { redisClient } from '../config/redis';
import { getAllCircuitBreakerStatuses } from '../utils/circuitBreaker';
import socketMetricsService from './socketMetricsService';
import { getIndexerLagSnapshot } from './monitorService';

const LATENCY_BUCKETS_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

interface HistogramSnapshot {
  count: number;
  sumSeconds: number;
  bucketCounts: number[];
}

interface MongoPoolSnapshot {
  total: number;
  available: number;
  introspectionAvailable: boolean;
}

const escapeLabel = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

const labelsToString = (labels: Record<string, string | number>): string =>
  '{' +
  Object.entries(labels)
    .map(([key, value]) => key + '="' + escapeLabel(String(value)) + '"')
    .join(',') +
  '}';

const safeMetricLabel = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 100) || 'unknown';

const readMongoPoolSnapshot = (): MongoPoolSnapshot => {
  try {
    const connection = mongoose.connection;
    const topology = (connection.getClient() as unknown as {
      topology?: {
        s?: {
          servers?: Map<
            string,
            {
              s?: {
                pool?: {
                  totalConnectionCount?: number;
                  availableConnectionCount?: number;
                };
              };
            }
          >;
        };
      };
    }).topology;

    const servers = topology?.s?.servers;
    if (!servers || typeof servers.values !== 'function') {
      return { total: 0, available: 0, introspectionAvailable: false };
    }

    let total = 0;
    let available = 0;
    let poolsFound = 0;
    for (const server of servers.values()) {
      const pool = server.s?.pool;
      if (!pool) continue;
      poolsFound += 1;
      total += pool.totalConnectionCount ?? 0;
      available += pool.availableConnectionCount ?? 0;
    }

    return { total, available, introspectionAvailable: poolsFound > 0 };
  } catch {
    return { total: 0, available: 0, introspectionAvailable: false };
  }
};

/**
 * Collects process-local HTTP metrics and snapshots of existing operational
 * dependencies. Request labels use Express route templates rather than raw
 * URLs so identifiers and arbitrary query strings never become metric labels.
 */
class PrometheusMetricsService {
  private readonly requestCounters = new Map<string, number>();
  private readonly requestHistograms = new Map<string, HistogramSnapshot>();

  public recordRequest(
    method: string,
    route: string,
    statusCode: number,
    durationMs: number,
  ): void {
    const normalizedMethod = method.toUpperCase();
    const normalizedRoute = route || 'unmatched';
    const counterKey = JSON.stringify([normalizedMethod, normalizedRoute, statusCode]);
    this.requestCounters.set(counterKey, (this.requestCounters.get(counterKey) ?? 0) + 1);

    const histogramKey = JSON.stringify([normalizedMethod, normalizedRoute]);
    let histogram = this.requestHistograms.get(histogramKey);
    if (!histogram) {
      histogram = {
        count: 0,
        sumSeconds: 0,
        bucketCounts: LATENCY_BUCKETS_SECONDS.map(() => 0),
      };
      this.requestHistograms.set(histogramKey, histogram);
    }

    const durationSeconds = Math.max(0, durationMs) / 1000;
    histogram.count += 1;
    histogram.sumSeconds += durationSeconds;
    LATENCY_BUCKETS_SECONDS.forEach((boundary, index) => {
      if (durationSeconds <= boundary) histogram!.bucketCounts[index] += 1;
    });
  }

  public async render(): Promise<string> {
    const lines: string[] = [];
    const gauge = (name: string, help: string, value: number): void => {
      lines.push(
        '# HELP ' + name + ' ' + help,
        '# TYPE ' + name + ' gauge',
        name + ' ' + (Number.isFinite(value) ? value : 0),
      );
    };
    const counter = (name: string, help: string, value: number): void => {
      lines.push(
        '# HELP ' + name + ' ' + help,
        '# TYPE ' + name + ' counter',
        name + ' ' + (Number.isFinite(value) ? value : 0),
      );
    };

    lines.push(
      '# HELP swiftchain_http_requests_total Total HTTP requests served by route.',
      '# TYPE swiftchain_http_requests_total counter',
    );
    for (const [key, value] of this.requestCounters) {
      const [method, route, statusCode] = JSON.parse(key) as [string, string, number];
      lines.push(
        'swiftchain_http_requests_total' +
          labelsToString({ method, route, status_code: statusCode }) +
          ' ' +
          value,
      );
    }

    lines.push(
      '# HELP swiftchain_http_request_duration_seconds HTTP request duration in seconds.',
      '# TYPE swiftchain_http_request_duration_seconds histogram',
    );
    for (const [key, histogram] of this.requestHistograms) {
      const [method, route] = JSON.parse(key) as [string, string];
      LATENCY_BUCKETS_SECONDS.forEach((boundary, index) => {
        lines.push(
          'swiftchain_http_request_duration_seconds_bucket' +
            labelsToString({ method, route, le: boundary }) +
            ' ' +
            histogram.bucketCounts[index],
        );
      });
      lines.push(
        'swiftchain_http_request_duration_seconds_bucket' +
          labelsToString({ method, route, le: '+Inf' }) +
          ' ' +
          histogram.count,
        'swiftchain_http_request_duration_seconds_sum' +
          labelsToString({ method, route }) +
          ' ' +
          histogram.sumSeconds,
        'swiftchain_http_request_duration_seconds_count' +
          labelsToString({ method, route }) +
          ' ' +
          histogram.count,
      );
    }

    gauge(
      'swiftchain_process_uptime_seconds',
      'Process uptime in seconds.',
      process.uptime(),
    );
    const memory = process.memoryUsage();
    gauge(
      'swiftchain_process_resident_memory_bytes',
      'Resident process memory in bytes.',
      memory.rss,
    );
    gauge(
      'swiftchain_process_heap_used_bytes',
      'Node.js heap memory used in bytes.',
      memory.heapUsed,
    );
    gauge(
      'swiftchain_process_heap_total_bytes',
      'Node.js heap memory allocated in bytes.',
      memory.heapTotal,
    );

    const mongoPool = readMongoPoolSnapshot();
    gauge(
      'swiftchain_mongodb_connection_ready',
      'Whether the Mongoose connection is connected.',
      mongoose.connection.readyState === 1 ? 1 : 0,
    );
    gauge(
      'swiftchain_mongodb_pool_stats_available',
      'Whether MongoDB driver pool statistics could be read from the active topology.',
      mongoPool.introspectionAvailable ? 1 : 0,
    );
    lines.push(
      '# HELP swiftchain_mongodb_pool_connections MongoDB pool connections by state.',
      '# TYPE swiftchain_mongodb_pool_connections gauge',
      'swiftchain_mongodb_pool_connections' +
        labelsToString({ state: 'total' }) +
        ' ' +
        mongoPool.total,
      'swiftchain_mongodb_pool_connections' +
        labelsToString({ state: 'available' }) +
        ' ' +
        mongoPool.available,
      'swiftchain_mongodb_pool_connections' +
        labelsToString({ state: 'in_use' }) +
        ' ' +
        Math.max(0, mongoPool.total - mongoPool.available),
    );

    let redisHealthy = 0;
    if (redisClient.status === 'ready') {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const ping = redisClient.ping().then((response) => response === 'PONG');
        const timedOut = new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => resolve(false), 1000);
          timeout.unref?.();
        });
        redisHealthy = (await Promise.race([ping, timedOut])) ? 1 : 0;
      } catch {
        redisHealthy = 0;
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }
    gauge('swiftchain_redis_healthy', 'Whether Redis responds to a PING command.', redisHealthy);

    const breakers = getAllCircuitBreakerStatuses();
    lines.push(
      '# HELP swiftchain_circuit_breaker_open Whether a named circuit breaker is open or half-open.',
      '# TYPE swiftchain_circuit_breaker_open gauge',
    );
    for (const breaker of breakers) {
      lines.push(
        'swiftchain_circuit_breaker_open' +
          labelsToString({ name: safeMetricLabel(breaker.name), state: breaker.state }) +
          ' ' +
          (breaker.state === 'closed' ? 0 : 1),
      );
    }

    try {
      const lag = await getIndexerLagSnapshot();
      gauge(
        'swiftchain_indexer_lag_available',
        'Whether indexer lag could be measured.',
        lag ? 1 : 0,
      );
      if (lag) {
        gauge(
          'swiftchain_indexer_lag_ledgers',
          'Number of ledgers the indexer trails the network by.',
          lag.lagLedgers,
        );
      }
    } catch {
      gauge(
        'swiftchain_indexer_lag_available',
        'Whether indexer lag could be measured.',
        0,
      );
    }

    const socketMetrics = socketMetricsService.getMetrics();
    gauge(
      'swiftchain_socket_connected_sockets',
      'Currently connected Socket.IO clients.',
      socketMetrics.connectedSockets,
    );
    counter(
      'swiftchain_socket_connections_total',
      'Total Socket.IO connections since process start.',
      socketMetrics.totalConnections,
    );
    counter(
      'swiftchain_socket_disconnections_total',
      'Total Socket.IO disconnections since process start.',
      socketMetrics.totalDisconnections,
    );
    counter(
      'swiftchain_socket_messages_processed_total',
      'Total Socket.IO messages processed since process start.',
      socketMetrics.messagesProcessed,
    );
    gauge(
      'swiftchain_socket_message_latency_p50_ms',
      'Socket.IO message latency p50 in milliseconds.',
      socketMetrics.messageLatencyMs.p50,
    );
    gauge(
      'swiftchain_socket_message_latency_p95_ms',
      'Socket.IO message latency p95 in milliseconds.',
      socketMetrics.messageLatencyMs.p95,
    );
    gauge(
      'swiftchain_socket_message_latency_p99_ms',
      'Socket.IO message latency p99 in milliseconds.',
      socketMetrics.messageLatencyMs.p99,
    );

    return lines.join('\n') + '\n';
  }
}

export const prometheusMetricsService = new PrometheusMetricsService();
export default prometheusMetricsService;
