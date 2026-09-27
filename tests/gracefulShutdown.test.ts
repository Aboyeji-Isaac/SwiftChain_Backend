/**
 * Unit tests for GracefulShutdownService and requestTracker middleware.
 *
 * Verifies the drain sequence:
 *   - stop accepting new HTTP work (503)
 *   - close HTTP server / idle connections
 *   - drain Socket.IO
 *   - wait for DB transactions then disconnect
 *   - exit cleanly (or with code 1 on failure / timeout)
 */

import http from 'http';
import express from 'express';
import request from 'supertest';

jest.mock('../src/config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../src/services/monitorService', () => ({
  stopIndexerLagMonitor: jest.fn(),
  startIndexerLagMonitor: jest.fn(),
}));

jest.mock('../src/services/escrowMonitorService', () => ({
  stopEscrowMonitorService: jest.fn(),
  startEscrowMonitorService: jest.fn(),
}));

jest.mock('../src/services/eventPoller', () => ({
  stopEventPoller: jest.fn(),
  startEventPoller: jest.fn(),
}));

const mockShutdownSocketServer = jest.fn().mockResolvedValue(undefined);
jest.mock('../src/sockets/connectionHandler', () => ({
  shutdownSocketServer: (...args: unknown[]) => mockShutdownSocketServer(...args),
}));

const mockWaitForActiveTransactions = jest.fn().mockResolvedValue(undefined);
const mockDisconnectDatabase = jest.fn().mockResolvedValue(undefined);
jest.mock('../src/config/database', () => ({
  waitForActiveTransactions: (...args: unknown[]) => mockWaitForActiveTransactions(...args),
  disconnectDatabase: (...args: unknown[]) => mockDisconnectDatabase(...args),
  connectDatabase: jest.fn(),
}));

import { GracefulShutdownService } from '../src/services/gracefulShutdownService';
import {
  requestTracker,
  beginRequestDrain,
  getInFlightRequestCount,
  isServerShuttingDown,
  resetRequestTracker,
} from '../src/middleware/requestTracker';
import { stopIndexerLagMonitor } from '../src/services/monitorService';
import { stopEscrowMonitorService } from '../src/services/escrowMonitorService';
import { stopEventPoller } from '../src/services/eventPoller';
import { TypedServer } from '../src/sockets/connectionHandler';

describe('requestTracker middleware', () => {
  beforeEach(() => {
    resetRequestTracker();
  });

  it('increments and decrements the in-flight counter around a request', async () => {
    const app = express();
    app.use(requestTracker);
    app.get('/ok', (_req, res) => {
      expect(getInFlightRequestCount()).toBe(1);
      res.status(200).json({ ok: true });
    });

    await request(app).get('/ok').expect(200);
    expect(getInFlightRequestCount()).toBe(0);
  });

  it('rejects new requests with 503 once drain has begun', async () => {
    const app = express();
    app.use(requestTracker);
    app.get('/ok', (_req, res) => res.status(200).json({ ok: true }));

    beginRequestDrain();
    expect(isServerShuttingDown()).toBe(true);

    const res = await request(app).get('/ok');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      success: false,
      error: 'Server is shutting down',
    });
    expect(getInFlightRequestCount()).toBe(0);
  });
});

describe('GracefulShutdownService', () => {
  let httpServer: http.Server;
  let exitFn: jest.Mock;
  const io = {} as TypedServer;

  beforeEach(() => {
    resetRequestTracker();
    jest.clearAllMocks();
    mockShutdownSocketServer.mockResolvedValue(undefined);
    mockWaitForActiveTransactions.mockResolvedValue(undefined);
    mockDisconnectDatabase.mockResolvedValue(undefined);

    httpServer = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });

    exitFn = jest.fn();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (httpServer.listening) {
        httpServer.close(() => resolve());
      } else {
        resolve();
      }
    });
  });

  it('stops jobs, closes HTTP, drains sockets and DB, then exits 0', async () => {
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const service = new GracefulShutdownService({
      httpServer,
      io,
      exitFn,
      timeoutMs: 5_000,
    });

    await service.shutdown('SIGTERM');

    expect(stopEventPoller).toHaveBeenCalled();
    expect(stopEscrowMonitorService).toHaveBeenCalled();
    expect(stopIndexerLagMonitor).toHaveBeenCalled();
    expect(mockShutdownSocketServer).toHaveBeenCalledWith(io);
    expect(mockWaitForActiveTransactions).toHaveBeenCalled();
    expect(mockDisconnectDatabase).toHaveBeenCalled();
    expect(exitFn).toHaveBeenCalledWith(0);
    expect(service.shuttingDown).toBe(true);
    expect(isServerShuttingDown()).toBe(true);
  });

  it('ignores a second concurrent shutdown signal', async () => {
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const service = new GracefulShutdownService({
      httpServer,
      io,
      exitFn,
      timeoutMs: 5_000,
    });

    const first = service.shutdown('SIGTERM');
    const second = service.shutdown('SIGINT');
    await Promise.all([first, second]);

    expect(mockShutdownSocketServer).toHaveBeenCalledTimes(1);
    expect(exitFn).toHaveBeenCalledTimes(1);
    expect(exitFn).toHaveBeenCalledWith(0);
  });

  it('exits with code 1 when socket drain fails', async () => {
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    mockShutdownSocketServer.mockRejectedValueOnce(new Error('socket drain failed'));

    const service = new GracefulShutdownService({
      httpServer,
      io,
      exitFn,
      timeoutMs: 5_000,
    });

    await service.shutdown('SIGTERM');

    expect(exitFn).toHaveBeenCalledWith(1);
  });
});
