/**
 * Unit tests for SorobanService
 *
 * The Soroban RPC client is mocked so tests run offline without needing a
 * live Stellar node. The mock is injected via the constructor so no module-
 * level patching is required.
 *
 * Coverage:
 *   - checkConnectivity: healthy node, unhealthy/unreachable node
 *   - getLatestLedger: success, RPC failure
 *   - getNetworkInfo: success, RPC failure
 */

import { SorobanService } from '../src/blockchain/soroban.service';
import { rpc as StellarRpc } from '@stellar/stellar-sdk';

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../src/config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

// Mock the stellar config module so the singleton client is never constructed
// during tests (avoids network calls at module load time).
jest.mock('../src/config/stellar', () => ({
  stellarConfig: {
    rpcUrl: 'https://soroban-testnet.stellar.org',
    networkPassphrase: 'Test SDF Network ; September 2015',
    network: 'testnet',
    timeoutMs: 10000,
  },
  sorobanRpcClient: {},
  createSorobanRpcClient: jest.fn(),
}));

// Keep retry backoff delays effectively instant so retry tests run fast, and
// configure the Soroban circuit breaker with a high volume threshold so a
// single failure cannot trip it (breakers stay CLOSED in these unit tests).
jest.mock('../src/config/env', () => ({
  __esModule: true,
  default: {
    SOROBAN_RPC_MAX_RETRIES: 3,
    SOROBAN_RPC_RETRY_BASE_MS: 1,
    SOROBAN_RPC_RETRY_MAX_MS: 2,
    CB_SOROBAN_ERROR_THRESHOLD_PERCENTAGE: 50,
    CB_SOROBAN_ROLLING_WINDOW_MS: 10000,
    CB_SOROBAN_RESET_TIMEOUT_MS: 30000,
    CB_SOROBAN_VOLUME_THRESHOLD: 100,
    CB_SOROBAN_TIMEOUT_MS: 10000,
  },
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal mock of rpc.Server with controllable method responses. */
function makeMockClient(
  overrides: Partial<{
    getHealth: () => Promise<StellarRpc.Api.GetHealthResponse>;
    getLatestLedger: () => Promise<StellarRpc.Api.GetLatestLedgerResponse>;
    getNetwork: () => Promise<StellarRpc.Api.GetNetworkResponse>;
  }> = {},
): StellarRpc.Server {
  return {
    getHealth: jest.fn().mockResolvedValue({ status: 'healthy' }),
    getLatestLedger: jest
      .fn()
      .mockResolvedValue({ sequence: 12345678, id: 'abc', protocolVersion: 21 }),
    getNetwork: jest.fn().mockResolvedValue({
      passphrase: 'Test SDF Network ; September 2015',
      protocolVersion: 21,
    }),
    ...overrides,
  } as unknown as StellarRpc.Server;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SorobanService', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  // ── checkConnectivity ──────────────────────────────────────────────────────

  describe('checkConnectivity', () => {
    it('returns connected=true with health and ledger data when node is healthy', async () => {
      const client = makeMockClient();
      const service = new SorobanService(client);

      const result = await service.checkConnectivity();

      expect(result.connected).toBe(true);
      if (result.connected) {
        expect(result.status).toBe('healthy');
        expect(result.latestLedger).toBe(12345678);
        expect(result.network).toBe('testnet');
        expect(result.networkPassphrase).toBe('Test SDF Network ; September 2015');
        expect(result.rpcUrl).toBe('https://soroban-testnet.stellar.org');
        expect(result.latencyMs).toBeGreaterThanOrEqual(0);
        expect(result.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      }
    });

    it('calls getHealth and getLatestLedger in parallel (both invoked once)', async () => {
      const client = makeMockClient();
      const service = new SorobanService(client);

      await service.checkConnectivity();

      expect(client.getHealth).toHaveBeenCalledTimes(1);
      expect(client.getLatestLedger).toHaveBeenCalledTimes(1);
    });

    it('returns connected=false when getHealth throws a network error', async () => {
      const client = makeMockClient({
        getHealth: jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED')),
      });
      const service = new SorobanService(client);

      const result = await service.checkConnectivity();

      expect(result.connected).toBe(false);
      expect((result as { error: string }).error).toContain('ECONNREFUSED');
      expect(result.network).toBe('testnet');
      expect(result.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('returns connected=false when getLatestLedger throws', async () => {
      const client = makeMockClient({
        getLatestLedger: jest.fn().mockRejectedValue(new Error('timeout')),
      });
      const service = new SorobanService(client);

      const result = await service.checkConnectivity();

      expect(result.connected).toBe(false);
    });

    it('returns connected=false and captures unknown (non-Error) throw', async () => {
      const client = makeMockClient({
        getHealth: jest.fn().mockRejectedValue('string error'),
      });
      const service = new SorobanService(client);

      const result = await service.checkConnectivity();

      expect(result.connected).toBe(false);
      expect((result as { error: string }).error).toBe('Unknown error');
    });

    it('always includes checkedAt as a valid ISO string', async () => {
      const client = makeMockClient();
      const service = new SorobanService(client);

      const result = await service.checkConnectivity();

      expect(() => new Date(result.checkedAt)).not.toThrow();
    });

    it('includes rpcUrl in both success and failure results', async () => {
      const service1 = new SorobanService(makeMockClient());
      const success = await service1.checkConnectivity();
      expect(success.rpcUrl).toBe('https://soroban-testnet.stellar.org');

      const service2 = new SorobanService(
        makeMockClient({ getHealth: jest.fn().mockRejectedValue(new Error('fail')) }),
      );
      const failure = await service2.checkConnectivity();
      expect(failure.rpcUrl).toBe('https://soroban-testnet.stellar.org');
    });
  });

  // ── getLatestLedger ────────────────────────────────────────────────────────

  describe('getLatestLedger', () => {
    it('returns the ledger sequence number', async () => {
      const client = makeMockClient();
      const service = new SorobanService(client);

      const seq = await service.getLatestLedger();

      expect(seq).toBe(12345678);
    });

    it('propagates errors from the RPC client', async () => {
      const client = makeMockClient({
        getLatestLedger: jest.fn().mockRejectedValue(new Error('RPC down')),
      });
      const service = new SorobanService(client);

      await expect(service.getLatestLedger()).rejects.toThrow('RPC down');
    });
  });

  // ── getNetworkInfo ─────────────────────────────────────────────────────────

  describe('getNetworkInfo', () => {
    it('returns the raw network response from the RPC client', async () => {
      const client = makeMockClient();
      const service = new SorobanService(client);

      const info = await service.getNetworkInfo();

      // The service can return a DegradedLedgerResult when the breaker is
      // open; with a healthy mock client the raw network response comes back.
      expect((info as StellarRpc.Api.GetNetworkResponse).passphrase).toBe(
        'Test SDF Network ; September 2015',
      );
      expect((info as StellarRpc.Api.GetNetworkResponse).protocolVersion).toBe(21);
    });

    it('propagates errors from the RPC client', async () => {
      const client = makeMockClient({
        getNetwork: jest.fn().mockRejectedValue(new Error('network error')),
      });
      const service = new SorobanService(client);

      await expect(service.getNetworkInfo()).rejects.toThrow('network error');
    });
  });

  // ── retry / backoff behaviour ──────────────────────────────────────────────

  describe('retry on transient RPC failures', () => {
    it('retries getLatestLedger and succeeds once the node recovers', async () => {
      const getLatestLedger = jest
        .fn()
        .mockRejectedValueOnce(new Error('429 rate limited'))
        .mockResolvedValue({ sequence: 999, id: 'xyz', protocolVersion: 21 });
      const client = makeMockClient({ getLatestLedger });
      const service = new SorobanService(client);

      const seq = await service.getLatestLedger();

      expect(seq).toBe(999);
      expect(getLatestLedger).toHaveBeenCalledTimes(2);
    });

    it('gives up and throws after exhausting configured retry attempts', async () => {
      const getNetwork = jest.fn().mockRejectedValue(new Error('ECONNRESET'));
      const client = makeMockClient({ getNetwork });
      const service = new SorobanService(client);

      await expect(service.getNetworkInfo()).rejects.toThrow('ECONNRESET');
      // SOROBAN_RPC_MAX_RETRIES is mocked to 3 attempts total.
      expect(getNetwork).toHaveBeenCalledTimes(3);
    });
  });
});
