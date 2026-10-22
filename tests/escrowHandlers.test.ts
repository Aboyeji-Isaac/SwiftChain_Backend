/**
 * Unit tests for the escrow_funded indexer handler.
 *
 * Events are built with the real `nativeToScVal` encoder from
 * @stellar/stellar-sdk so the parser is exercised against genuinely
 * XDR-encoded values, the same shape it receives from a live RPC node.
 */

import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { nativeToScVal, rpc as StellarRpc } from '@stellar/stellar-sdk';
import { parseEscrowFundedEvent, handleEscrowFundedEvent } from '../src/indexer/escrowHandlers';
import Delivery, { DeliveryStatus } from '../src/models/Delivery';
import Escrow from '../src/models/Escrow';

jest.mock('../src/config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

function makeEvent(
  overrides: Partial<StellarRpc.Api.EventResponse> = {},
): StellarRpc.Api.EventResponse {
  return {
    id: '0000000001-0000000000',
    type: 'contract' as StellarRpc.Api.EventType,
    ledger: 100,
    ledgerClosedAt: new Date().toISOString(),
    pagingToken: '0000000001-0000000000',
    inSuccessfulContractCall: true,
    txHash: 'a'.repeat(64),
    topic: [
      nativeToScVal('escrow_funded', { type: 'symbol' }),
      nativeToScVal('delivery-placeholder', { type: 'string' }),
    ],
    value: nativeToScVal(
      { amount: BigInt(1000), asset: 'XLM', funded_by: 'GABCDEFGH' },
      { type: 'instance' },
    ),
    ...overrides,
  } as StellarRpc.Api.EventResponse;
}

describe('parseEscrowFundedEvent', () => {
  it('parses a well-formed escrow_funded event', () => {
    const deliveryId = new Types.ObjectId().toHexString();
    const event = makeEvent({
      topic: [
        nativeToScVal('escrow_funded', { type: 'symbol' }),
        nativeToScVal(deliveryId, { type: 'string' }),
      ],
    });

    const parsed = parseEscrowFundedEvent(event);

    expect(parsed).not.toBeNull();
    expect(parsed?.deliveryId).toBe(deliveryId);
    expect(parsed?.amount).toBe(1000);
    expect(parsed?.asset).toBe('XLM');
    expect(parsed?.fundedBy).toBe('GABCDEFGH');
  });

  it('returns null when the delivery id topic is missing', () => {
    const event = makeEvent({ topic: [nativeToScVal('escrow_funded', { type: 'symbol' })] });

    expect(parseEscrowFundedEvent(event)).toBeNull();
  });

  it('returns null when the data map is missing required fields', () => {
    const event = makeEvent({
      value: nativeToScVal({ asset: 'XLM' }, { type: 'instance' }),
    });

    expect(parseEscrowFundedEvent(event)).toBeNull();
  });
});

describe('handleEscrowFundedEvent (integration)', () => {
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

  it('creates an Escrow and marks the Delivery as funded', async () => {
    const delivery = await Delivery.create({
      deliveryId: 'DEL-1',
      trackingNumber: 'TRK-1',
      status: DeliveryStatus.PENDING,
    });

    const event = makeEvent({
      topic: [
        nativeToScVal('escrow_funded', { type: 'symbol' }),
        nativeToScVal(delivery.id, { type: 'string' }),
      ],
    });

    const result = await handleEscrowFundedEvent(event, 'CESCROWCONTRACT');

    expect(result.status).toBe('processed');

    const escrow = await Escrow.findOne({ contractId: 'CESCROWCONTRACT' });
    expect(escrow).not.toBeNull();
    expect(escrow!.amount).toBe(1000);
    expect(escrow!.transactions).toHaveLength(1);

    const updatedDelivery = await Delivery.findById(delivery.id);
    expect(updatedDelivery!.status).toBe(DeliveryStatus.FUNDED);
  });

  it('is idempotent for a repeated transaction hash', async () => {
    const delivery = await Delivery.create({
      deliveryId: 'DEL-2',
      trackingNumber: 'TRK-2',
      status: DeliveryStatus.PENDING,
    });

    const event = makeEvent({
      txHash: 'b'.repeat(64),
      topic: [
        nativeToScVal('escrow_funded', { type: 'symbol' }),
        nativeToScVal(delivery.id, { type: 'string' }),
      ],
    });

    await handleEscrowFundedEvent(event, 'CESCROWCONTRACT2');
    await handleEscrowFundedEvent(event, 'CESCROWCONTRACT2');

    const escrow = await Escrow.findOne({ contractId: 'CESCROWCONTRACT2' });
    expect(escrow!.transactions).toHaveLength(1);
  });

  it('ignores an event that fails to parse without throwing', async () => {
    const event = makeEvent({ topic: [nativeToScVal('escrow_funded', { type: 'symbol' })] });

    const result = await handleEscrowFundedEvent(event, 'CESCROWCONTRACT3');

    expect(result.status).toBe('ignored');
  });
});
