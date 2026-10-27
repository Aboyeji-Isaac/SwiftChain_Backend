jest.mock('mongoose', () => ({
  connection: {
    readyState: 1,
    getClient: jest.fn(() => ({ topology: { s: { servers: new Map() } } })),
  },
}));

jest.mock('../../src/config/redis', () => ({
  redisClient: {
    status: 'ready',
    ping: jest.fn().mockResolvedValue('PONG'),
  },
}));

jest.mock('../../src/utils/circuitBreaker', () => ({
  getAllCircuitBreakerStatuses: jest.fn(() => [
    { name: 'soroban-rpc', state: 'open', stats: {} },
    { name: 'database', state: 'closed', stats: {} },
  ]),
}));

jest.mock('../../src/services/socketMetricsService', () => ({
  __esModule: true,
  default: {
    getMetrics: jest.fn(() => ({
      connectedSockets: 3,
      totalConnections: 12,
      totalDisconnections: 9,
      messagesProcessed: 44,
      messageLatencyMs: { p50: 5, p95: 15, p99: 20 },
      memoryUsageBytes: { heapUsedMB: 10, heapTotalMB: 20, rssMB: 30, externalMB: 1 },
      timestamp: '2026-01-01T00:00:00.000Z',
    })),
  },
}));

jest.mock('../../src/services/monitorService', () => ({
  getIndexerLagSnapshot: jest.fn().mockResolvedValue({
    network: 'testnet',
    processedLedger: 100,
    networkLedger: 125,
    lagLedgers: 25,
  }),
}));

import prometheusMetricsService from '../../src/services/prometheusMetricsService';
import mongoose from 'mongoose';
import { redisClient } from '../../src/config/redis';
import { getIndexerLagSnapshot } from '../../src/services/monitorService';

const mongoConnection = (mongoose as unknown as { connection: { getClient: jest.Mock } }).connection;
const redis = redisClient as unknown as { status: string; ping: jest.Mock };
const indexerLagSnapshot = getIndexerLagSnapshot as jest.Mock;

describe('PrometheusMetricsService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mongoConnection.getClient.mockImplementation(() => ({
      topology: { s: { servers: new Map() } },
    }));
    redis.status = 'ready';
    redis.ping.mockResolvedValue('PONG');
    indexerLagSnapshot.mockResolvedValue({
      network: 'testnet',
      processedLedger: 100,
      networkLedger: 125,
      lagLedgers: 25,
    });
  });

  it('renders valid Prometheus declarations and request histogram samples', async () => {
    prometheusMetricsService.recordRequest('get', '/api/v1/drivers/:driverId', 200, 30);

    const output = await prometheusMetricsService.render();

    expect(output).toContain('# TYPE swiftchain_http_requests_total counter');
    expect(output).toContain('# TYPE swiftchain_http_request_duration_seconds histogram');
    expect(output).toContain(
      'swiftchain_http_requests_total{method="GET",route="/api/v1/drivers/:driverId",status_code="200"} 1',
    );
    expect(output).toContain(
      'swiftchain_http_request_duration_seconds_bucket' +
        '{method="GET",route="/api/v1/drivers/:driverId",le="0.05"} 1',
    );
    expect(output).toContain(
      'swiftchain_http_request_duration_seconds_count{method="GET",route="/api/v1/drivers/:driverId"} 1',
    );
  });

  it('includes operational dependency and existing Socket.IO metrics', async () => {
    const output = await prometheusMetricsService.render();

    expect(output).toContain('swiftchain_mongodb_connection_ready 1');
    expect(output).toContain('swiftchain_redis_healthy 1');
    expect(output).toContain('swiftchain_circuit_breaker_open{name="soroban-rpc",state="open"} 1');
    expect(output).toContain('swiftchain_indexer_lag_ledgers 25');
    expect(output).toContain('swiftchain_socket_connected_sockets 3');
    expect(output).toContain('# TYPE swiftchain_socket_connections_total counter');
  });

  it('exports MongoDB pool utilization when driver pool statistics are available', async () => {
    mongoConnection.getClient.mockReturnValue({
      topology: {
        s: {
          servers: new Map([
            ['primary', { s: { pool: { totalConnectionCount: 10, availableConnectionCount: 4 } } }],
          ]),
        },
      },
    });

    const output = await prometheusMetricsService.render();

    expect(output).toContain('swiftchain_mongodb_pool_stats_available 1');
    expect(output).toContain('swiftchain_mongodb_pool_connections{state="total"} 10');
    expect(output).toContain('swiftchain_mongodb_pool_connections{state="available"} 4');
    expect(output).toContain('swiftchain_mongodb_pool_connections{state="in_use"} 6');
  });

  it('reports unavailable dependencies without failing the metrics scrape', async () => {
    mongoConnection.getClient.mockImplementation(() => {
      throw new Error('MongoDB is disconnected');
    });
    redis.status = 'wait';
    indexerLagSnapshot.mockResolvedValueOnce(null);

    const output = await prometheusMetricsService.render();

    expect(output).toContain('swiftchain_mongodb_pool_stats_available 0');
    expect(output).toContain('swiftchain_redis_healthy 0');
    expect(output).toContain('swiftchain_indexer_lag_available 0');
    expect(output.split('\n').some((line) => line.startsWith('swiftchain_indexer_lag_ledgers '))).toBe(false);
  });

  it('handles Redis and indexer probe errors without breaking exposition output', async () => {
    redis.ping.mockRejectedValueOnce(new Error('Redis unavailable'));
    indexerLagSnapshot.mockRejectedValueOnce(new Error('RPC unavailable'));

    const output = await prometheusMetricsService.render();

    expect(output).toContain('swiftchain_redis_healthy 0');
    expect(output).toContain('swiftchain_indexer_lag_available 0');
    expect(output).toContain('# TYPE swiftchain_http_requests_total counter');
  });

  it('escapes label values before rendering', async () => {
    prometheusMetricsService.recordRequest('GET', '/api/v1/items/"special"', 500, 10);

    const output = await prometheusMetricsService.render();

    expect(output).toContain('route="/api/v1/items/' + '\\' + '"special' + '\\' + '""');
  });
});
