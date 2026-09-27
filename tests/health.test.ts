/**
 * Comprehensive tests for GET /api/v1/health (issue #104).
 *
 * Test strategy
 * ─────────────
 * The service layer (healthService) is unit-tested in isolation by mocking
 * its two infrastructure dependencies:
 *   - mongoose.connection (readyState + db.command)
 *   - sorobanService.checkConnectivity()
 *
 * The HTTP layer (controller + route) is integration-tested with supertest
 * using the same mocks so the full Express stack is exercised — middleware,
 * routing, status codes, and response envelope — without any live network or
 * database connections.
 *
 * Pattern follows the existing project conventions observed in:
 *   - tests/monitorRoutes.test.ts   (supertest + jest.mock)
 *   - tests/monitorService.test.ts  (in-process MongoDB + mocked Soroban)
 *   - tests/soroban.service.test.ts (pure unit, injected mock client)
 */

import request from 'supertest';
import mongoose from 'mongoose';
import app from '../src/app';
import { checkHealth } from '../src/services/healthService';

// ─── Global mocks ─────────────────────────────────────────────────────────────

// Prevent the app from attempting a real DB connection on import.
jest.mock('../src/config/database', () => ({
  connectDatabase: jest.fn(),
  disconnectDatabase: jest.fn(),
  waitForActiveTransactions: jest.fn(),
  startTrackedSession: jest.fn(),
  getActiveTransactionCount: jest.fn().mockReturnValue(0),
}));

// Silence winston output during tests.
jest.mock('../src/config/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

// Mock sorobanService so no real Stellar RPC calls are made.
jest.mock('../src/blockchain/soroban.service', () => ({
  sorobanService: {
    checkConnectivity: jest.fn(),
  },
}));

// Import the mocked singleton AFTER jest.mock() declarations.
import { sorobanService } from '../src/blockchain/soroban.service';

const mockedCheckConnectivity = sorobanService.checkConnectivity as jest.MockedFunction<
  typeof sorobanService.checkConnectivity
>;

// ─── Shared test fixtures ──────────────────────────────────────────────────────

const STELLAR_HEALTHY = {
  connected: true as const,
  network: 'testnet',
  networkPassphrase: 'Test SDF Network ; September 2015',
  rpcUrl: 'https://soroban-testnet.stellar.org',
  status: 'healthy',
  latestLedger: 12345678,
  checkedAt: '2026-01-01T00:00:00.000Z',
  latencyMs: 95,
};

const STELLAR_UNHEALTHY = {
  connected: false as const,
  network: 'testnet',
  rpcUrl: 'https://soroban-testnet.stellar.org',
  checkedAt: '2026-01-01T00:00:00.000Z',
  error: 'connect ECONNREFUSED 127.0.0.1:443',
};

/** Configure mongoose.connection.readyState and optionally mock db.command. */
function setMongoState(readyState: number, pingResult: 'ok' | Error = 'ok'): void {
  Object.defineProperty(mongoose.connection, 'readyState', {
    get: () => readyState,
    configurable: true,
  });

  const commandMock =
    pingResult === 'ok'
      ? jest.fn().mockResolvedValue({ ok: 1 })
      : jest.fn().mockRejectedValue(pingResult);

  Object.defineProperty(mongoose.connection, 'db', {
    get: () => ({ command: commandMock }),
    configurable: true,
  });
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  // Default: healthy MongoDB + healthy Stellar.
  setMongoState(1);
  mockedCheckConnectivity.mockResolvedValue(STELLAR_HEALTHY);
});

// ─── Unit tests: healthService ─────────────────────────────────────────────────

describe('healthService.checkHealth()', () => {
  it('returns overall=healthy when MongoDB is connected and Stellar RPC is up', async () => {
    const result = await checkHealth();

    expect(result.status).toBe('healthy');
    expect(result.services.mongodb.status).toBe('healthy');
    expect(result.services.mongodb.readyState).toBe(1);
    expect(result.services.mongodb.readyStateLabel).toBe('connected');
    expect(result.services.stellarRpc.status).toBe('healthy');
    expect(result.services.stellarRpc.network).toBe('testnet');
    expect(result.services.stellarRpc.latestLedger).toBe(12345678);
    expect(result.services.stellarRpc.latencyMs).toBe(95);
    expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof result.uptime).toBe('number');
    expect(result.uptime).toBeGreaterThanOrEqual(0);
  });

  it('returns overall=degraded when MongoDB is disconnected (readyState=0)', async () => {
    setMongoState(0);

    const result = await checkHealth();

    expect(result.status).toBe('degraded');
    expect(result.services.mongodb.status).toBe('unhealthy');
    expect(result.services.mongodb.readyState).toBe(0);
    expect(result.services.mongodb.readyStateLabel).toBe('disconnected');
    expect(result.services.mongodb.error).toBeDefined();
    // Stellar is still checked independently.
    expect(result.services.stellarRpc.status).toBe('healthy');
  });

  it('returns overall=degraded when MongoDB is in connecting state (readyState=2)', async () => {
    setMongoState(2);

    const result = await checkHealth();

    expect(result.status).toBe('degraded');
    expect(result.services.mongodb.status).toBe('unhealthy');
    expect(result.services.mongodb.readyStateLabel).toBe('connecting');
  });

  it('returns overall=degraded when MongoDB ping fails despite readyState=1', async () => {
    setMongoState(1, new Error('MongoNetworkError: connection timed out'));

    const result = await checkHealth();

    expect(result.status).toBe('degraded');
    expect(result.services.mongodb.status).toBe('unhealthy');
    expect(result.services.mongodb.error).toContain('timed out');
  });

  it('returns overall=degraded when Stellar RPC is unreachable', async () => {
    mockedCheckConnectivity.mockResolvedValue(STELLAR_UNHEALTHY);

    const result = await checkHealth();

    expect(result.status).toBe('degraded');
    expect(result.services.stellarRpc.status).toBe('unhealthy');
    expect(result.services.stellarRpc.error).toContain('ECONNREFUSED');
    // MongoDB is still checked independently.
    expect(result.services.mongodb.status).toBe('healthy');
  });

  it('returns overall=degraded when BOTH MongoDB and Stellar RPC are unhealthy', async () => {
    setMongoState(0);
    mockedCheckConnectivity.mockResolvedValue(STELLAR_UNHEALTHY);

    const result = await checkHealth();

    expect(result.status).toBe('degraded');
    expect(result.services.mongodb.status).toBe('unhealthy');
    expect(result.services.stellarRpc.status).toBe('unhealthy');
  });

  it('returns overall=degraded when Stellar RPC times out (circuit breaker open)', async () => {
    mockedCheckConnectivity.mockResolvedValue({
      connected: false,
      network: 'testnet',
      rpcUrl: 'https://soroban-testnet.stellar.org',
      checkedAt: new Date().toISOString(),
      error: 'Soroban RPC circuit breaker is OPEN — node temporarily unreachable',
    });

    const result = await checkHealth();

    expect(result.status).toBe('degraded');
    expect(result.services.stellarRpc.status).toBe('unhealthy');
    expect(result.services.stellarRpc.error).toContain('circuit breaker');
  });

  it('runs MongoDB and Stellar checks concurrently (checkConnectivity called once)', async () => {
    await checkHealth();

    expect(mockedCheckConnectivity).toHaveBeenCalledTimes(1);
  });

  it('always includes timestamp as a valid ISO-8601 string', async () => {
    const result = await checkHealth();

    expect(() => new Date(result.timestamp)).not.toThrow();
    expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
  });

  it('always includes a non-negative uptime number', async () => {
    const result = await checkHealth();

    expect(result.uptime).toBeGreaterThanOrEqual(0);
  });

  it('stellarRpc.checkedAt is always present on both healthy and unhealthy results', async () => {
    const healthy = await checkHealth();
    expect(healthy.services.stellarRpc.checkedAt).toBeDefined();

    mockedCheckConnectivity.mockResolvedValue(STELLAR_UNHEALTHY);
    const unhealthy = await checkHealth();
    expect(unhealthy.services.stellarRpc.checkedAt).toBeDefined();
  });

  it('does not expose the RPC URL in the error field', async () => {
    mockedCheckConnectivity.mockResolvedValue(STELLAR_UNHEALTHY);

    const result = await checkHealth();

    // The error message should not contain the literal RPC URL from the mock.
    // (sorobanService already sanitises this; we confirm it here too.)
    expect(result.services.stellarRpc.error).not.toContain('soroban-testnet.stellar.org');
  });
});

// ─── Integration tests: HTTP layer ────────────────────────────────────────────

describe('GET /api/v1/health', () => {
  // ── 200 path ────────────────────────────────────────────────────────────────

  it('returns 200 and status=success when all services are healthy', async () => {
    const res = await request(app).get('/api/v1/health');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('200 response includes data.status = "healthy"', async () => {
    const res = await request(app).get('/api/v1/health');

    expect(res.body.data.status).toBe('healthy');
  });

  it('200 response body has correct shape', async () => {
    const res = await request(app).get('/api/v1/health');

    expect(res.body).toMatchObject({
      success: true,
      data: {
        status: 'healthy',
        services: {
          mongodb: {
            status: 'healthy',
            readyState: expect.any(Number),
            readyStateLabel: expect.any(String),
          },
          stellarRpc: {
            status: 'healthy',
            network: expect.any(String),
            latestLedger: expect.any(Number),
            checkedAt: expect.any(String),
          },
        },
        timestamp: expect.any(String),
        uptime: expect.any(Number),
      },
    });
  });

  it('200 response does not expose an error field on mongodb when healthy', async () => {
    const res = await request(app).get('/api/v1/health');

    expect(res.body.data.services.mongodb.error).toBeUndefined();
  });

  it('200 response does not expose an error field on stellarRpc when healthy', async () => {
    const res = await request(app).get('/api/v1/health');

    expect(res.body.data.services.stellarRpc.error).toBeUndefined();
  });

  // ── 503 path — MongoDB unhealthy ─────────────────────────────────────────

  it('returns 503 and status=error when MongoDB is disconnected', async () => {
    setMongoState(0);

    const res = await request(app).get('/api/v1/health');

    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
  });

  it('503 response includes data.status = "degraded" when MongoDB is disconnected', async () => {
    setMongoState(0);

    const res = await request(app).get('/api/v1/health');

    expect(res.body.data.status).toBe('degraded');
    expect(res.body.data.services.mongodb.status).toBe('unhealthy');
  });

  it('503 response still reports Stellar as healthy when only MongoDB is down', async () => {
    setMongoState(0);

    const res = await request(app).get('/api/v1/health');

    expect(res.body.data.services.stellarRpc.status).toBe('healthy');
  });

  // ── 503 path — Stellar RPC unhealthy ─────────────────────────────────────

  it('returns 503 and status=error when Stellar RPC is unreachable', async () => {
    mockedCheckConnectivity.mockResolvedValue(STELLAR_UNHEALTHY);

    const res = await request(app).get('/api/v1/health');

    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
  });

  it('503 response includes stellarRpc.status = "unhealthy" when RPC is down', async () => {
    mockedCheckConnectivity.mockResolvedValue(STELLAR_UNHEALTHY);

    const res = await request(app).get('/api/v1/health');

    expect(res.body.data.services.stellarRpc.status).toBe('unhealthy');
  });

  it('503 response still reports MongoDB as healthy when only Stellar RPC is down', async () => {
    mockedCheckConnectivity.mockResolvedValue(STELLAR_UNHEALTHY);

    const res = await request(app).get('/api/v1/health');

    expect(res.body.data.services.mongodb.status).toBe('healthy');
  });

  // ── 503 path — both unhealthy ─────────────────────────────────────────────

  it('returns 503 when both MongoDB and Stellar RPC are unhealthy', async () => {
    setMongoState(0);
    mockedCheckConnectivity.mockResolvedValue(STELLAR_UNHEALTHY);

    const res = await request(app).get('/api/v1/health');

    expect(res.status).toBe(503);
    expect(res.body.data.services.mongodb.status).toBe('unhealthy');
    expect(res.body.data.services.stellarRpc.status).toBe('unhealthy');
  });

  // ── Content-Type ──────────────────────────────────────────────────────────

  it('returns Content-Type application/json', async () => {
    const res = await request(app).get('/api/v1/health');

    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  // ── Route registration sanity check ──────────────────────────────────────

  it('is reachable at /api/v1/health, with /health as a liveness probe', async () => {
    const versioned = await request(app).get('/api/v1/health');
    expect(versioned.status).not.toBe(404);

    // The flat /health path remains as a lightweight liveness probe for load
    // balancers; the comprehensive check lives at /api/v1/health.
    const legacy = await request(app).get('/health');
    expect(legacy.status).toBe(200);
  });

  // ── Existing circuit-breakers sub-route is still intact ──────────────────

  it('does not break the existing /api/v1/health/circuit-breakers route', async () => {
    const res = await request(app).get('/api/v1/health/circuit-breakers');

    // Circuit-breakers route returns 200 or 206; definitely not 404 or 500.
    expect([200, 206]).toContain(res.status);
    expect(res.body).toHaveProperty('success', true);
    expect(res.body.data).toHaveProperty('breakers');
  });
});
