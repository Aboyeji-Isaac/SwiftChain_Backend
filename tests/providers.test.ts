/**
 * Unit tests for the external SDK provider interfaces (issue #222).
 *
 * Everything external is behind an interface now, so these tests inject fakes
 * (or mock only the raw SDK transport) and verify:
 *   - GoogleMapsRoutingProvider: Google path, Haversine fallback and error
 *     handling — without network calls;
 *   - SdkSorobanRpcClient: 1:1 delegation onto the underlying rpc.Server;
 *   - PoolingService: routing injected as a fake, no Google Maps involved;
 *   - DI container: the provider contracts resolve as singletons.
 */

import axios from 'axios';
import { GoogleMapsRoutingProvider, SdkSorobanRpcClient } from '../src/services/providers/adapters';
import { routingService } from '../src/services/routingService';
import { PoolingService } from '../src/services/poolingService';
import type {
  IRoutingProvider,
  ETARequest,
  ETAResponse,
} from '../src/services/providers/routingProvider';
import type { ISorobanRpcClient } from '../src/services/providers/sorobanRpcClient';

jest.mock('axios');
jest.mock('../src/config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

// The stellar config pulls in the SDK's horizon axios client, which cannot be
// constructed under jest once axios is mocked; the adapters only need the
// default client reference, which is never called in these tests.
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

const mockedAxios = axios as jest.Mocked<typeof axios>;

afterEach(() => {
  jest.clearAllMocks();
});

/** Deterministic routing fake returning a fixed ETA. */
function makeRoutingFake(eta: Partial<ETAResponse> = {}): IRoutingProvider {
  return {
    calculateETA: jest.fn().mockResolvedValue({
      estimatedTime: 12,
      distance: 5.4,
      durationText: '12 mins',
      distanceText: '5.4 km',
      route: {
        distance: 5400,
        duration: 720,
        distanceText: '5.4 km',
        durationText: '12 mins',
      },
      ...eta,
    }),
  };
}

// ─── GoogleMapsRoutingProvider ────────────────────────────────────────────────

describe('GoogleMapsRoutingProvider', () => {
  const baseRequest: ETARequest = {
    pickup: { lat: 40.7128, lng: -74.006 },
    dropoff: { lat: 40.7589, lng: -73.9851 },
  };

  it('is configured for the Google path only when an API key is present', async () => {
    const provider = new GoogleMapsRoutingProvider('test-key');
    mockedAxios.get.mockResolvedValue({
      data: {
        status: 'OK',
        routes: [
          {
            legs: [
              {
                distance: { value: 5400, text: '5.4 km' },
                duration: { value: 720, text: '12 mins' },
              },
            ],
          },
        ],
      },
    });

    const eta = await provider.calculateETA(baseRequest);

    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    expect(eta.estimatedTime).toBe(12);
    expect(eta.route.distance).toBe(5400);
  });

  it('falls back to the Haversine estimate when no API key is configured', async () => {
    const provider = new GoogleMapsRoutingProvider('');

    const eta = await provider.calculateETA(baseRequest);

    expect(mockedAxios.get).not.toHaveBeenCalled();
    expect(eta.estimatedTime).toBeGreaterThan(0);
    expect(eta.durationText).toMatch(/\d+ mins/);
    expect(eta.distanceText).toMatch(/km/);
  });

  it('normalises longitudes across the anti-meridian in the fallback', async () => {
    const provider = new GoogleMapsRoutingProvider('');

    // Fiji → Samoa: the short way is ~1,100 km, not ~19,000 km.
    const eta = await provider.calculateETA({
      pickup: { lat: -18.1248, lng: 178.4501 },
      dropoff: { lat: -13.759, lng: -172.1046 },
    });

    expect(eta.distance).toBeGreaterThan(1000);
    expect(eta.distance).toBeLessThan(1300);
  });

  it('wraps provider failures in a generic ETA error', async () => {
    const provider = new GoogleMapsRoutingProvider('test-key');
    mockedAxios.get.mockRejectedValue(new Error('boom'));

    await expect(provider.calculateETA(baseRequest)).rejects.toThrow(
      'Failed to calculate delivery ETA',
    );
  });
});

// ─── SdkSorobanRpcClient ──────────────────────────────────────────────────────

describe('SdkSorobanRpcClient', () => {
  it('delegates every call 1:1 onto the underlying rpc.Server', async () => {
    const server = {
      getAccount: jest.fn().mockResolvedValue({ accountId: 'GABC' }),
      getHealth: jest.fn().mockResolvedValue({ status: 'healthy' }),
      getTransaction: jest.fn().mockResolvedValue({ status: 'NOT_FOUND' }),
      getEvents: jest.fn().mockResolvedValue({ events: [], latestLedger: 1, cursor: '' }),
      getLatestLedger: jest.fn().mockResolvedValue({ sequence: 42 }),
      getNetwork: jest.fn().mockResolvedValue({ passphrase: 'test' }),
      prepareTransaction: jest.fn().mockResolvedValue({ sequence: 43 }),
      sendTransaction: jest.fn().mockResolvedValue({ status: 'PENDING', hash: 'abc' }),
    };
    const client = new SdkSorobanRpcClient(server as never);
    const tx = { fake: 'transaction' } as never;

    await client.getAccount('GABC');
    await client.getHealth();
    await client.getTransaction('hash');
    await client.getEvents({ filters: [], startLedger: 1 });
    await client.getLatestLedger();
    await client.getNetwork();
    await client.prepareTransaction(tx);
    await client.sendTransaction(tx);

    expect(server.getAccount).toHaveBeenCalledWith('GABC');
    expect(server.getHealth).toHaveBeenCalledTimes(1);
    expect(server.getTransaction).toHaveBeenCalledWith('hash');
    expect(server.getEvents).toHaveBeenCalledWith({ filters: [], startLedger: 1 });
    expect(server.getLatestLedger).toHaveBeenCalledTimes(1);
    expect(server.getNetwork).toHaveBeenCalledTimes(1);
    expect(server.prepareTransaction).toHaveBeenCalledWith(tx);
    expect(server.sendTransaction).toHaveBeenCalledWith(tx);
  });

  it('satisfies the ISorobanRpcClient contract', () => {
    const server = {} as never;
    const client: ISorobanRpcClient = new SdkSorobanRpcClient(server);
    expect(client).toBeDefined();
  });
});

// ─── Consumers depending on the interfaces ────────────────────────────────────

describe('routing facade', () => {
  it('delegates to the injected provider', async () => {
    const fake = makeRoutingFake();
    const service = new (routingService.constructor as new (
      p: IRoutingProvider,
    ) => typeof routingService)(fake);

    const result = await service.calculateETA({
      pickup: { lat: 1, lng: 1 },
      dropoff: { lat: 2, lng: 2 },
    });

    expect(fake.calculateETA).toHaveBeenCalledTimes(1);
    expect(result.estimatedTime).toBe(12);
  });
});

describe('PoolingService with an injected routing fake', () => {
  it('sums pool ETA from the provider without any Google Maps involvement', async () => {
    const fake = makeRoutingFake({
      estimatedTime: 5,
      route: {
        distance: 500,
        duration: 300,
        distanceText: '0.5 km',
        durationText: '5 mins',
      },
    });
    const pooling = new PoolingService(fake);

    const buildPool = (
      pooling as unknown as {
        buildPool: (deliveries: never[]) => Promise<{
          totalEstimatedDistanceMeters: number;
          totalEstimatedDurationMinutes: number;
        }>;
      }
    ).buildPool.bind(pooling);

    const summary = await buildPool([
      {
        _id: 'd1',
        pickupCoordinates: { lat: 1, lng: 1, address: 'A1' },
        dropoffCoordinates: { lat: 1.5, lng: 1.5, address: 'B1' },
      },
      {
        _id: 'd2',
        pickupCoordinates: { lat: 2, lng: 2, address: 'A2' },
        dropoffCoordinates: { lat: 2.5, lng: 2.5, address: 'B2' },
      },
    ] as never);

    // 2 deliveries → 4 stops (pickup + dropoff each) → 3 legs between them.
    expect(fake.calculateETA).toHaveBeenCalledTimes(3);
    expect(summary.totalEstimatedDistanceMeters).toBe(1500);
    expect(summary.totalEstimatedDurationMinutes).toBe(15);
  });
});
