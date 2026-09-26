/**
 * Unit/integration tests for disputeService + disputeHandlers.
 *
 * Uses an in-memory MongoDB for persistence (project convention). The
 * outbound notification webhook is mocked via axios.
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

jest.mock('axios');

// The stellar config pulls in the SDK's horizon axios client, which cannot be
// constructed under jest; disputeService only calls sorobanService.getLatestLedger.
jest.mock('../src/config/stellar', () => ({
  stellarConfig: { network: 'testnet' },
  sorobanRpcClient: {},
}));

jest.mock('../src/blockchain/soroban.service', () => ({
  sorobanService: {
    getLatestLedger: jest.fn(),
  },
}));

import { Dispute, DisputeStatus } from '../src/models/Dispute';
import { disputeService } from '../src/services/disputeService';
import {
  handleDisputeOpened,
  handleDisputeResolved,
  dispatchDisputeEvent,
} from '../src/indexer/disputeHandlers';
import env from '../src/config/env';

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

describe('handleDisputeOpened', () => {
  it('creates a local Dispute record from the on-chain event', async () => {
    await handleDisputeOpened({
      disputeId: 'dispute-1',
      deliveryId: 'delivery-1',
      openedBy: 'GABC...OPENER',
      reason: 'Package damaged',
      ledgerSequence: 1000,
    });

    const dispute = await Dispute.findOne({ disputeId: 'dispute-1' });
    expect(dispute).not.toBeNull();
    expect(dispute?.status).toBe(DisputeStatus.OPEN);
    expect(dispute?.deliveryId).toBe('delivery-1');
    expect(dispute?.openedLedger).toBe(1000);
  });

  it('is idempotent when the same disputeId is processed twice', async () => {
    const input = {
      disputeId: 'dispute-2',
      deliveryId: 'delivery-2',
      openedBy: 'GABC...OPENER',
      ledgerSequence: 500,
    };

    await handleDisputeOpened(input);
    await handleDisputeOpened(input);

    const count = await Dispute.countDocuments({ disputeId: 'dispute-2' });
    expect(count).toBe(1);
  });

  it('ignores a malformed payload without throwing', async () => {
    await expect(
      handleDisputeOpened({
        disputeId: '',
        deliveryId: 'delivery-3',
        openedBy: 'GABC',
        ledgerSequence: 1,
      }),
    ).resolves.not.toThrow();

    const count = await Dispute.countDocuments();
    expect(count).toBe(0);
  });
});

describe('handleDisputeResolved', () => {
  it('marks an existing dispute resolved', async () => {
    await Dispute.create({
      disputeId: 'dispute-4',
      deliveryId: 'delivery-4',
      openedBy: 'GABC...OPENER',
      raisedBy: 'GABC...OPENER',
      reason: 'other',
      description: 'On-chain dispute',
      status: DisputeStatus.OPEN,
      openedLedger: 100,
    });

    await handleDisputeResolved({
      disputeId: 'dispute-4',
      resolution: 'Refund issued',
      ledgerSequence: 200,
    });

    const dispute = await Dispute.findOne({ disputeId: 'dispute-4' });
    expect(dispute?.status).toBe(DisputeStatus.RESOLVED);
    expect(dispute?.resolution).toBe('Refund issued');
    expect(dispute?.resolvedLedger).toBe(200);
    expect(dispute?.resolvedAt).toBeInstanceOf(Date);
  });

  it('does not throw when resolving a dispute that was never opened locally', async () => {
    await expect(
      handleDisputeResolved({
        disputeId: 'unknown-dispute',
        resolution: 'n/a',
        ledgerSequence: 1,
      }),
    ).resolves.not.toThrow();
  });

  it('notifies the configured webhook on resolution', async () => {
    const originalWebhookUrl = env.DISPUTE_NOTIFICATION_WEBHOOK_URL;
    (env as { DISPUTE_NOTIFICATION_WEBHOOK_URL: string }).DISPUTE_NOTIFICATION_WEBHOOK_URL =
      'https://example.com/dispute-webhook';
    mockedAxiosPost.mockResolvedValue({ status: 200 });

    try {
      await Dispute.create({
        disputeId: 'dispute-5',
        deliveryId: 'delivery-5',
        openedBy: 'GABC...OPENER',
        raisedBy: 'GABC...OPENER',
        reason: 'other',
        description: 'On-chain dispute',
        status: DisputeStatus.OPEN,
        openedLedger: 100,
      });

      await handleDisputeResolved({
        disputeId: 'dispute-5',
        resolution: 'Refund issued',
        ledgerSequence: 200,
      });

      expect(mockedAxiosPost).toHaveBeenCalledWith(
        'https://example.com/dispute-webhook',
        expect.objectContaining({ event: 'dispute_resolved', disputeId: 'dispute-5' }),
      );
    } finally {
      (env as { DISPUTE_NOTIFICATION_WEBHOOK_URL: string }).DISPUTE_NOTIFICATION_WEBHOOK_URL =
        originalWebhookUrl;
    }
  });
});

describe('dispatchDisputeEvent', () => {
  it('routes dispute_opened to handleDisputeOpened', async () => {
    await dispatchDisputeEvent('dispute_opened', {
      disputeId: 'dispute-6',
      deliveryId: 'delivery-6',
      openedBy: 'GABC',
      ledgerSequence: 1,
    });

    const dispute = await Dispute.findOne({ disputeId: 'dispute-6' });
    expect(dispute).not.toBeNull();
  });

  it('ignores unknown event types', async () => {
    await expect(
      dispatchDisputeEvent('something_else', {
        disputeId: 'dispute-7',
        deliveryId: 'delivery-7',
        openedBy: 'GABC',
        ledgerSequence: 1,
      }),
    ).resolves.not.toThrow();

    const count = await Dispute.countDocuments({ disputeId: 'dispute-7' });
    expect(count).toBe(0);
  });
});

describe('disputeService.listDisputes / getDisputeById', () => {
  it('paginates and filters by status', async () => {
    await Dispute.create([
      {
        disputeId: 'a',
        deliveryId: 'd1',
        openedBy: 'G1',
        raisedBy: 'G1',
        reason: 'other',
        description: 'On-chain dispute',
        status: DisputeStatus.OPEN,
        openedLedger: 1,
      },
      {
        disputeId: 'b',
        deliveryId: 'd2',
        openedBy: 'G2',
        raisedBy: 'G2',
        reason: 'other',
        description: 'On-chain dispute',
        status: DisputeStatus.RESOLVED,
        openedLedger: 2,
        resolvedLedger: 3,
      },
    ]);

    const openOnly = await disputeService.listDisputes(1, 20, DisputeStatus.OPEN);
    expect(openOnly.data).toHaveLength(1);
    expect(openOnly.data[0].disputeId).toBe('a');
    expect(openOnly.pagination.total).toBe(1);
  });

  it('throws a not-found error for an unknown disputeId', async () => {
    await expect(disputeService.getDisputeById('does-not-exist')).rejects.toThrow(/not found/i);
  });
});
