/**
 * Unit/integration tests for monitorService.
 *
 * Uses an in-memory MongoDB so IndexerStatus/IndexerAlert reads and writes
 * are exercised against a real database (per project convention), while the
 * Soroban RPC client and outbound webhook HTTP calls are mocked.
 */

import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import axios from 'axios';

jest.mock('../src/config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../src/blockchain/soroban.service', () => ({
  sorobanService: {
    getLatestLedger: jest.fn(),
  },
}));

// The stellar config pulls in the SDK's horizon axios client, which cannot be
// constructed under jest; monitorService only reads `stellarConfig.network`.
jest.mock('../src/config/stellar', () => ({
  stellarConfig: { network: 'testnet' },
  sorobanRpcClient: {},
}));

jest.mock('axios');

import { sorobanService } from '../src/blockchain/soroban.service';
import { IndexerStatus } from '../src/models/IndexerStatus';
import { IndexerAlert } from '../src/models/IndexerAlert';
import env from '../src/config/env';
import {
  checkIndexerLag,
  getOrCreateIndexerStatus,
  recordProcessedLedger,
  getRecentAlerts,
} from '../src/services/monitorService';

const mockedGetLatestLedger = sorobanService.getLatestLedger as jest.Mock;
const mockedAxiosPost = axios.post as jest.Mock;

let mongoServer: MongoMemoryServer;
const SETUP_TIMEOUT = 120_000;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
}, SETUP_TIMEOUT);

afterEach(async () => {
  jest.clearAllMocks();
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    await collections[key].deleteMany({});
  }
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
}, 15_000);

describe('getOrCreateIndexerStatus', () => {
  it('seeds a checkpoint at the current network ledger on first run', async () => {
    mockedGetLatestLedger.mockResolvedValue(1000);

    const status = await getOrCreateIndexerStatus();

    expect(status.lastProcessedLedger).toBe(1000);
    expect(mockedGetLatestLedger).toHaveBeenCalledTimes(1);
  });

  it('returns the existing checkpoint without calling the RPC client', async () => {
    await IndexerStatus.create({ network: 'testnet', lastProcessedLedger: 500 });

    const status = await getOrCreateIndexerStatus();

    expect(status.lastProcessedLedger).toBe(500);
    expect(mockedGetLatestLedger).not.toHaveBeenCalled();
  });
});

describe('recordProcessedLedger', () => {
  it('creates a checkpoint when none exists', async () => {
    await recordProcessedLedger(42);

    const status = await IndexerStatus.findOne({ network: 'testnet' });
    expect(status?.lastProcessedLedger).toBe(42);
  });

  it('advances the checkpoint forward', async () => {
    await IndexerStatus.create({ network: 'testnet', lastProcessedLedger: 100 });

    await recordProcessedLedger(150);

    const status = await IndexerStatus.findOne({ network: 'testnet' });
    expect(status?.lastProcessedLedger).toBe(150);
  });

  it('does not move the checkpoint backwards', async () => {
    await IndexerStatus.create({ network: 'testnet', lastProcessedLedger: 200 });

    await recordProcessedLedger(150);

    const status = await IndexerStatus.findOne({ network: 'testnet' });
    expect(status?.lastProcessedLedger).toBe(200);
  });
});

describe('checkIndexerLag', () => {
  it('reports breached=false and does not persist an alert when lag is within threshold', async () => {
    await IndexerStatus.create({ network: 'testnet', lastProcessedLedger: 1000 });
    mockedGetLatestLedger.mockResolvedValue(1000 + env.INDEXER_LAG_ALERT_THRESHOLD);

    const result = await checkIndexerLag();

    expect(result.breached).toBe(false);
    expect(result.lagLedgers).toBe(env.INDEXER_LAG_ALERT_THRESHOLD);
    await expect(IndexerAlert.countDocuments()).resolves.toBe(0);
  });

  it('reports breached=true and persists an alert when lag exceeds threshold', async () => {
    await IndexerStatus.create({ network: 'testnet', lastProcessedLedger: 1000 });
    mockedGetLatestLedger.mockResolvedValue(1000 + env.INDEXER_LAG_ALERT_THRESHOLD + 1);

    const result = await checkIndexerLag();

    expect(result.breached).toBe(true);
    const alerts = await IndexerAlert.find();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].lagLedgers).toBe(env.INDEXER_LAG_ALERT_THRESHOLD + 1);
    expect(alerts[0].webhookConfigured).toBe(false);
  });

  it('notifies the webhook and records success when configured and reachable', async () => {
    const originalWebhookUrl = env.INDEXER_LAG_WEBHOOK_URL;
    (env as { INDEXER_LAG_WEBHOOK_URL: string }).INDEXER_LAG_WEBHOOK_URL =
      'https://example.com/webhook';
    mockedAxiosPost.mockResolvedValue({ status: 200 });

    try {
      await IndexerStatus.create({ network: 'testnet', lastProcessedLedger: 1000 });
      mockedGetLatestLedger.mockResolvedValue(1000 + env.INDEXER_LAG_ALERT_THRESHOLD + 1);

      await checkIndexerLag();

      expect(mockedAxiosPost).toHaveBeenCalledWith(
        'https://example.com/webhook',
        expect.objectContaining({ event: 'indexer_lag_alert' }),
      );
      const alerts = await IndexerAlert.find();
      expect(alerts[0].webhookConfigured).toBe(true);
      expect(alerts[0].webhookNotified).toBe(true);
    } finally {
      (env as { INDEXER_LAG_WEBHOOK_URL: string }).INDEXER_LAG_WEBHOOK_URL = originalWebhookUrl;
    }
  });

  it('records webhook failure without throwing when the webhook is unreachable', async () => {
    const originalWebhookUrl = env.INDEXER_LAG_WEBHOOK_URL;
    (env as { INDEXER_LAG_WEBHOOK_URL: string }).INDEXER_LAG_WEBHOOK_URL =
      'https://example.com/webhook';
    mockedAxiosPost.mockRejectedValue(new Error('connect ECONNREFUSED'));

    try {
      await IndexerStatus.create({ network: 'testnet', lastProcessedLedger: 1000 });
      mockedGetLatestLedger.mockResolvedValue(1000 + env.INDEXER_LAG_ALERT_THRESHOLD + 1);

      const result = await checkIndexerLag();

      expect(result.breached).toBe(true);
      const alerts = await IndexerAlert.find();
      expect(alerts[0].webhookNotified).toBe(false);
      expect(alerts[0].webhookError).toContain('ECONNREFUSED');
    } finally {
      (env as { INDEXER_LAG_WEBHOOK_URL: string }).INDEXER_LAG_WEBHOOK_URL = originalWebhookUrl;
    }
  });
});

describe('getRecentAlerts', () => {
  it('returns alerts newest first, bounded by limit', async () => {
    await IndexerAlert.create([
      {
        network: 'testnet',
        processedLedger: 1,
        networkLedger: 100,
        lagLedgers: 99,
        thresholdLedgers: 50,
        // createdAt is immutable after insert (Mongoose timestamps), so the
        // older timestamp must be provided at creation time to make the
        // "newest first" assertion deterministic.
        createdAt: new Date(Date.now() - 60_000),
      },
      {
        network: 'testnet',
        processedLedger: 2,
        networkLedger: 200,
        lagLedgers: 198,
        thresholdLedgers: 50,
      },
    ]);

    const alerts = await getRecentAlerts(1);

    expect(alerts).toHaveLength(1);
    expect(alerts[0].processedLedger).toBe(2);
  });
});
