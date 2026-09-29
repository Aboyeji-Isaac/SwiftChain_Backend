/**
 * Unit tests for escrow resolution event handlers (escrow_released and escrow_refunded).
 *
 * Tests the parseEscrowResolutionEvent parser, event handlers, and service layer
 * integration for both release and refund flows.
 */

import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { nativeToScVal, rpc as StellarRpc } from '@stellar/stellar-sdk';
import {
  parseEscrowResolutionEvent,
  handleEscrowReleasedEvent,
  handleEscrowRefundedEvent,
} from '../src/indexer/escrowHandlers';
import { escrowIndexerService } from '../src/services/escrowIndexerService';
import Escrow, { EscrowStatus } from '../src/models/Escrow';
import Delivery from '../src/models/Delivery';

jest.mock('../src/config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

/**
 * Helper to construct a mock Soroban event with escrow resolution data.
 */
function makeResolutionEvent(
  eventType: 'escrow_released' | 'escrow_refunded',
  overrides: Partial<StellarRpc.Api.EventResponse> = {},
): StellarRpc.Api.EventResponse {
  const escrowId = new Types.ObjectId().toHexString();

  return {
    id: '0000000001-0000000000',
    type: 'contract' as StellarRpc.Api.EventType,
    ledger: 100,
    ledgerClosedAt: new Date().toISOString(),
    pagingToken: '0000000001-0000000000',
    inSuccessfulContractCall: true,
    txHash: 'a'.repeat(64),
    topic: [
      nativeToScVal(eventType, { type: 'symbol' }),
      nativeToScVal(escrowId, { type: 'string' }),
    ],
    value: nativeToScVal(
      {
        amount: BigInt(5000),
        asset: 'USDC',
        recipient: 'GBUYER123456789012345678901234',
        transaction_hash: 'tx'.concat('a'.repeat(62)),
        ledger: 100,
        timestamp: BigInt(Math.floor(Date.now() / 1000)),
      },
      { type: 'instance' },
    ),
    ...overrides,
  } as StellarRpc.Api.EventResponse;
}

describe('parseEscrowResolutionEvent', () => {
  it('parses a well-formed escrow_released event', () => {
    const event = makeResolutionEvent('escrow_released');

    const parsed = parseEscrowResolutionEvent(event);

    expect(parsed).not.toBeNull();
    expect(parsed?.escrowId).toBeDefined();
    expect(typeof parsed?.amount).toBe('string');
    expect(parsed?.asset).toBe('USDC');
    expect(parsed?.recipient).toMatch(/^GB/);
    expect(parsed?.transactionHash).toMatch(/^tx/);
    expect(parsed?.ledger).toBe(100);
    expect(parsed?.timestamp).toBeGreaterThan(0);
  });

  it('parses a well-formed escrow_refunded event', () => {
    const event = makeResolutionEvent('escrow_refunded');

    const parsed = parseEscrowResolutionEvent(event);

    expect(parsed).not.toBeNull();
    expect(parsed?.escrowId).toBeDefined();
    expect(parsed?.amount).toBeDefined();
  });

  it('returns null when the escrow id topic is missing', () => {
    const event = makeResolutionEvent('escrow_released', {
      topic: [nativeToScVal('escrow_released', { type: 'symbol' })],
    });

    expect(parseEscrowResolutionEvent(event)).toBeNull();
  });

  it('returns null when the data map is missing required fields', () => {
    const event = makeResolutionEvent('escrow_released', {
      value: nativeToScVal({ asset: 'USDC' }, { type: 'instance' }),
    });

    expect(parseEscrowResolutionEvent(event)).toBeNull();
  });

  it('returns null when amount is not numeric', () => {
    const event = makeResolutionEvent('escrow_released', {
      value: nativeToScVal(
        {
          amount: 'invalid_amount',
          asset: 'USDC',
          recipient: 'GBUYER123456789012345678901234',
          transaction_hash: 'tx'.concat('a'.repeat(62)),
          ledger: 100,
          timestamp: BigInt(Math.floor(Date.now() / 1000)),
        },
        { type: 'instance' },
      ),
    });

    expect(parseEscrowResolutionEvent(event)).toBeNull();
  });
});

describe('handleEscrowReleasedEvent and service integration', () => {
  let mongod: MongoMemoryServer;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
  }, 60_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  }, 30_000);

  afterEach(async () => {
    await Escrow.deleteMany({});
    await Delivery.deleteMany({});
  });

  it('updates escrow status to released and records transaction', async () => {
    const _escrowId = new Types.ObjectId();
    const escrow = await Escrow.create({
      delivery: new Types.ObjectId(),
      status: EscrowStatus.LOCKED,
      amount: 5000,
      assetCode: 'USDC',
      contractId: 'CESCROWCONTRACT',
      lockTransactionHash: 'lock_tx_hash',
    });

    const event = makeResolutionEvent('escrow_released', {
      topic: [
        nativeToScVal('escrow_released', { type: 'symbol' }),
        nativeToScVal(String(escrow._id), { type: 'string' }),
      ],
    });

    const result = await handleEscrowReleasedEvent(event);

    expect(result.status).toBe('processed');

    const updated = await Escrow.findById(escrow._id);
    expect(updated?.status).toBe(EscrowStatus.RELEASED);
    expect(updated?.releaseTransactionHash).toBeDefined();
    expect(updated?.releasedAt).toBeDefined();
    expect(updated?.transactions).toHaveLength(1);
    expect(updated?.transactions[0].type).toBe('release');
  });

  it('is idempotent for a repeated transaction hash', async () => {
    const escrow = await Escrow.create({
      delivery: new Types.ObjectId(),
      status: EscrowStatus.LOCKED,
      amount: 5000,
      assetCode: 'USDC',
      contractId: 'CESCROWCONTRACT',
    });

    const txHash = 'a'.repeat(64);
    const event = makeResolutionEvent('escrow_released', {
      txHash,
      topic: [
        nativeToScVal('escrow_released', { type: 'symbol' }),
        nativeToScVal(String(escrow._id), { type: 'string' }),
      ],
    });

    // First call
    const result1 = await handleEscrowReleasedEvent(event);
    expect(result1.status).toBe('processed');

    // Second call with same transaction hash
    const result2 = await handleEscrowReleasedEvent(event);
    expect(result2.status).toBe('processed');

    const updated = await Escrow.findById(escrow._id);
    // Should have only one transaction (idempotent)
    expect(updated?.transactions).toHaveLength(1);
  });

  it('does not update an already-released escrow', async () => {
    const escrow = await Escrow.create({
      delivery: new Types.ObjectId(),
      status: EscrowStatus.RELEASED,
      amount: 5000,
      assetCode: 'USDC',
      contractId: 'CESCROWCONTRACT',
      releaseTransactionHash: 'original_release_tx',
    });

    const event = makeResolutionEvent('escrow_released', {
      txHash: 'different_tx'.concat('0'.repeat(46)),
      topic: [
        nativeToScVal('escrow_released', { type: 'symbol' }),
        nativeToScVal(String(escrow._id), { type: 'string' }),
      ],
    });

    const result = await handleEscrowReleasedEvent(event);
    expect(result.status).toBe('processed'); // processed (not ignored) because service handles it

    const unchanged = await Escrow.findById(escrow._id);
    // Should remain unchanged due to terminal status check
    expect(unchanged?.releaseTransactionHash).toBe('original_release_tx');
  });

  it('ignores an event that fails to parse', async () => {
    const event = makeResolutionEvent('escrow_released', {
      topic: [nativeToScVal('escrow_released', { type: 'symbol' })],
    });

    const result = await handleEscrowReleasedEvent(event);

    expect(result.status).toBe('ignored');
  });
});

describe('handleEscrowRefundedEvent and service integration', () => {
  let mongod: MongoMemoryServer;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
  }, 60_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  }, 30_000);

  afterEach(async () => {
    await Escrow.deleteMany({});
    await Delivery.deleteMany({});
  });

  it('updates escrow status to refunded and records transaction', async () => {
    const escrow = await Escrow.create({
      delivery: new Types.ObjectId(),
      status: EscrowStatus.LOCKED,
      amount: 5000,
      assetCode: 'USDC',
      contractId: 'CESCROWCONTRACT',
      lockTransactionHash: 'lock_tx_hash',
    });

    const event = makeResolutionEvent('escrow_refunded', {
      topic: [
        nativeToScVal('escrow_refunded', { type: 'symbol' }),
        nativeToScVal(String(escrow._id), { type: 'string' }),
      ],
    });

    const result = await handleEscrowRefundedEvent(event);

    expect(result.status).toBe('processed');

    const updated = await Escrow.findById(escrow._id);
    expect(updated?.status).toBe(EscrowStatus.REFUNDED);
    expect(updated?.refundTransactionHash).toBeDefined();
    expect(updated?.refundedAt).toBeDefined();
    expect(updated?.transactions).toHaveLength(1);
    expect(updated?.transactions[0].type).toBe('refund');
  });

  it('is idempotent for a repeated transaction hash', async () => {
    const escrow = await Escrow.create({
      delivery: new Types.ObjectId(),
      status: EscrowStatus.LOCKED,
      amount: 5000,
      assetCode: 'USDC',
      contractId: 'CESCROWCONTRACT',
    });

    const txHash = 'b'.repeat(64);
    const event = makeResolutionEvent('escrow_refunded', {
      txHash,
      topic: [
        nativeToScVal('escrow_refunded', { type: 'symbol' }),
        nativeToScVal(String(escrow._id), { type: 'string' }),
      ],
    });

    // First call
    const result1 = await handleEscrowRefundedEvent(event);
    expect(result1.status).toBe('processed');

    // Second call with same transaction hash
    const result2 = await handleEscrowRefundedEvent(event);
    expect(result2.status).toBe('processed');

    const updated = await Escrow.findById(escrow._id);
    // Should have only one transaction (idempotent)
    expect(updated?.transactions).toHaveLength(1);
  });

  it('does not update an already-refunded escrow', async () => {
    const escrow = await Escrow.create({
      delivery: new Types.ObjectId(),
      status: EscrowStatus.REFUNDED,
      amount: 5000,
      assetCode: 'USDC',
      contractId: 'CESCROWCONTRACT',
      refundTransactionHash: 'original_refund_tx',
    });

    const event = makeResolutionEvent('escrow_refunded', {
      txHash: 'different_tx'.concat('0'.repeat(46)),
      topic: [
        nativeToScVal('escrow_refunded', { type: 'symbol' }),
        nativeToScVal(String(escrow._id), { type: 'string' }),
      ],
    });

    const result = await handleEscrowRefundedEvent(event);
    expect(result.status).toBe('processed'); // processed (not ignored) because service handles it

    const unchanged = await Escrow.findById(escrow._id);
    // Should remain unchanged due to terminal status check
    expect(unchanged?.refundTransactionHash).toBe('original_refund_tx');
  });
});

describe('escrowIndexerService', () => {
  let mongod: MongoMemoryServer;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
  }, 60_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  }, 30_000);

  afterEach(async () => {
    await Escrow.deleteMany({});
  });

  describe('getEscrowByEscrowId', () => {
    it('retrieves an escrow by MongoDB ObjectId', async () => {
      const escrow = await Escrow.create({
        delivery: new Types.ObjectId(),
        status: EscrowStatus.LOCKED,
        amount: 5000,
        assetCode: 'USDC',
      });

      const retrieved = await escrowIndexerService.getEscrowByEscrowId(String(escrow._id));

      expect(retrieved).not.toBeNull();
      expect(retrieved?._id).toEqual(escrow._id);
    });

    it('retrieves an escrow by contract ID', async () => {
      const contractId = 'CESCROWCONTRACT';
      const _escrow = await Escrow.create({
        delivery: new Types.ObjectId(),
        status: EscrowStatus.LOCKED,
        amount: 5000,
        assetCode: 'USDC',
        contractId,
      });

      const retrieved = await escrowIndexerService.getEscrowByEscrowId(contractId);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.contractId).toBe(contractId);
    });

    it('returns null for non-existent escrow', async () => {
      const retrieved = await escrowIndexerService.getEscrowByEscrowId('nonexistent_id');

      expect(retrieved).toBeNull();
    });
  });

  describe('handleEscrowReleased', () => {
    it('updates escrow status and records transaction', async () => {
      const escrow = await Escrow.create({
        delivery: new Types.ObjectId(),
        status: EscrowStatus.LOCKED,
        amount: 5000,
        assetCode: 'USDC',
        contractId: 'CESCROWCONTRACT',
      });

      const event = {
        type: 'escrow_released' as const,
        escrowId: String(escrow._id),
        transactionHash: 'release_tx_123',
        amount: '5000',
        asset: 'USDC',
        ledger: 100,
        timestamp: Math.floor(Date.now() / 1000),
        recipient: 'GBUYER',
      };

      await escrowIndexerService.handleEscrowReleased(event);

      const updated = await Escrow.findById(escrow._id);
      expect(updated?.status).toBe(EscrowStatus.RELEASED);
      expect(updated?.releaseTransactionHash).toBe('release_tx_123');
    });
  });

  describe('handleEscrowRefunded', () => {
    it('updates escrow status and records transaction', async () => {
      const escrow = await Escrow.create({
        delivery: new Types.ObjectId(),
        status: EscrowStatus.LOCKED,
        amount: 5000,
        assetCode: 'USDC',
        contractId: 'CESCROWCONTRACT',
      });

      const event = {
        type: 'escrow_refunded' as const,
        escrowId: String(escrow._id),
        transactionHash: 'refund_tx_123',
        amount: '5000',
        asset: 'USDC',
        ledger: 100,
        timestamp: Math.floor(Date.now() / 1000),
        recipient: 'GSELLER',
      };

      await escrowIndexerService.handleEscrowRefunded(event);

      const updated = await Escrow.findById(escrow._id);
      expect(updated?.status).toBe(EscrowStatus.REFUNDED);
      expect(updated?.refundTransactionHash).toBe('refund_tx_123');
    });
  });
});
