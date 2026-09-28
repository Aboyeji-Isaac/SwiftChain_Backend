/**
 * Unit tests for the Escrow Mongoose model.
 *
 * Uses mongodb-memory-server to run a real (in-process) MongoDB instance so
 * schema validation, indexes, and defaults are exercised without mocking
 * Mongoose.
 */

import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import Escrow, { EscrowStatus } from '../src/models/Escrow';

describe('Escrow model', () => {
  let mongod: MongoMemoryServer;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    // Wait for the unique indexes before asserting duplicate writes.
    await Escrow.init();
  }, 60_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  }, 30_000);

  afterEach(async () => {
    await Escrow.deleteMany({});
  });

  it('creates an escrow with defaults applied', async () => {
    const escrow = await Escrow.create({
      delivery: new Types.ObjectId(),
      contractId: 'CCONTRACT1',
      amount: 100,
      assetCode: 'USDC',
    });

    expect(escrow.status).toBe(EscrowStatus.PENDING);
    expect(escrow.transactions).toHaveLength(0);
    expect(escrow.createdAt).toBeInstanceOf(Date);
    expect(escrow.updatedAt).toBeInstanceOf(Date);
  });

  it('rejects a duplicate contractId', async () => {
    await Escrow.create({
      delivery: new Types.ObjectId(),
      contractId: 'CDUPLICATE',
      amount: 50,
      assetCode: 'XLM',
    });

    await expect(
      Escrow.create({
        delivery: new Types.ObjectId(),
        contractId: 'CDUPLICATE',
        amount: 75,
        assetCode: 'XLM',
      }),
    ).rejects.toThrow();
  });

  it('rejects a negative amount', async () => {
    await expect(
      Escrow.create({
        delivery: new Types.ObjectId(),
        contractId: 'CNEGATIVE',
        amount: -10,
        assetCode: 'XLM',
      }),
    ).rejects.toThrow();
  });

  it('requires contractId, amount, asset, and delivery', async () => {
    await expect(Escrow.create({})).rejects.toThrow();
  });

  it('stores appended transaction hashes with type and ledger', async () => {
    const escrow = await Escrow.create({
      delivery: new Types.ObjectId(),
      contractId: 'CTX1',
      amount: 200,
      assetCode: 'USDC',
      status: EscrowStatus.LOCKED,
      transactions: [{ hash: 'abc123', type: 'fund', ledger: 42 }],
    });

    expect(escrow.transactions).toHaveLength(1);
    expect(escrow.transactions[0].hash).toBe('abc123');
    expect(escrow.transactions[0].type).toBe('fund');
    expect(escrow.transactions[0].ledger).toBe(42);
  });

  it('rejects a transaction hash reused across different escrows', async () => {
    await Escrow.create({
      delivery: new Types.ObjectId(),
      contractId: 'CTX2',
      amount: 10,
      assetCode: 'XLM',
      transactions: [{ hash: 'shared-hash', type: 'fund' }],
    });

    await expect(
      Escrow.create({
        delivery: new Types.ObjectId(),
        contractId: 'CTX3',
        amount: 20,
        assetCode: 'XLM',
        transactions: [{ hash: 'shared-hash', type: 'fund' }],
      }),
    ).rejects.toThrow();
  });
});
