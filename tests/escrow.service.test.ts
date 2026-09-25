/**
 * Unit tests for EscrowService.
 *
 * Uses mongodb-memory-server to run a real (in-process) MongoDB instance so
 * Escrow/Delivery interactions are tested without mocking Mongoose.
 */

import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { EscrowService } from '../src/services/escrow.service';
import Escrow, { EscrowStatus } from '../src/models/Escrow';
import Delivery, { DeliveryStatus } from '../src/models/Delivery';

jest.mock('../src/config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

describe('EscrowService', () => {
  let mongod: MongoMemoryServer;
  let service: EscrowService;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    service = new EscrowService();
  }, 60_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  }, 30_000);

  afterEach(async () => {
    await Escrow.deleteMany({});
    await Delivery.deleteMany({});
  });

  describe('recordEscrowFunded', () => {
    it('throws for an invalid deliveryId', async () => {
      await expect(
        service.recordEscrowFunded({
          contractId: 'CBAD',
          deliveryId: 'not-an-objectid',
          amount: 100,
          asset: 'USDC',
          transactionHash: 'hash1',
        }),
      ).rejects.toThrow('Invalid deliveryId');
    });

    it('throws when the delivery does not exist', async () => {
      await expect(
        service.recordEscrowFunded({
          contractId: 'CBAD2',
          deliveryId: new Types.ObjectId().toHexString(),
          amount: 100,
          asset: 'USDC',
          transactionHash: 'hash2',
        }),
      ).rejects.toThrow('Delivery not found');
    });

    it('creates a locked escrow and funds the delivery', async () => {
      const delivery = await Delivery.create({
        deliveryId: 'DEL-A',
        trackingNumber: 'TRK-A',
        status: DeliveryStatus.PENDING,
      });

      const escrow = await service.recordEscrowFunded({
        contractId: 'CFUND1',
        deliveryId: delivery.id,
        amount: 500,
        asset: 'XLM',
        fundedBy: 'GFUNDER',
        transactionHash: 'txfund1',
        ledger: 10,
      });

      expect(escrow.status).toBe(EscrowStatus.LOCKED);
      expect(escrow.amount).toBe(500);
      expect(escrow.payerAddress).toBe('GFUNDER');
      expect(escrow.transactions).toHaveLength(1);

      const updated = await Delivery.findById(delivery.id);
      expect(updated!.status).toBe(DeliveryStatus.FUNDED);
    });

    it('appends a new transaction and updates amount on a top-up', async () => {
      const delivery = await Delivery.create({
        deliveryId: 'DEL-B',
        trackingNumber: 'TRK-B',
        status: DeliveryStatus.PENDING,
      });

      await service.recordEscrowFunded({
        contractId: 'CFUND2',
        deliveryId: delivery.id,
        amount: 200,
        asset: 'XLM',
        transactionHash: 'txfund2a',
      });

      const topUp = await service.recordEscrowFunded({
        contractId: 'CFUND2',
        deliveryId: delivery.id,
        amount: 350,
        asset: 'XLM',
        transactionHash: 'txfund2b',
      });

      expect(topUp.amount).toBe(350);
      expect(topUp.transactions).toHaveLength(2);
    });

    it('is a no-op when the same transaction hash is replayed', async () => {
      const delivery = await Delivery.create({
        deliveryId: 'DEL-C',
        trackingNumber: 'TRK-C',
        status: DeliveryStatus.PENDING,
      });

      await service.recordEscrowFunded({
        contractId: 'CFUND3',
        deliveryId: delivery.id,
        amount: 100,
        asset: 'XLM',
        transactionHash: 'dup-hash',
      });

      const replay = await service.recordEscrowFunded({
        contractId: 'CFUND3',
        deliveryId: delivery.id,
        amount: 999,
        asset: 'XLM',
        transactionHash: 'dup-hash',
      });

      expect(replay.amount).toBe(100);
      expect(replay.transactions).toHaveLength(1);
    });
  });

  describe('getByDeliveryId / getByContractId', () => {
    it('throws for an invalid deliveryId', async () => {
      await expect(service.getByDeliveryId('not-an-objectid')).rejects.toThrow(
        'Invalid deliveryId',
      );
    });

    it('throws when no escrow exists for the delivery', async () => {
      await expect(service.getByDeliveryId(new Types.ObjectId().toHexString())).rejects.toThrow(
        'Escrow not found for delivery',
      );
    });

    it('throws when no escrow exists for the contract', async () => {
      await expect(service.getByContractId('CNONE')).rejects.toThrow(
        'Escrow not found for contract',
      );
    });

    it('returns the escrow by deliveryId and by contractId', async () => {
      const delivery = await Delivery.create({
        deliveryId: 'DEL-D',
        trackingNumber: 'TRK-D',
        status: DeliveryStatus.PENDING,
      });

      await service.recordEscrowFunded({
        contractId: 'CFUND4',
        deliveryId: delivery.id,
        amount: 100,
        asset: 'XLM',
        transactionHash: 'txfund4',
      });

      const byDelivery = await service.getByDeliveryId(delivery.id);
      const byContract = await service.getByContractId('CFUND4');

      expect(byDelivery.contractId).toBe('CFUND4');
      expect(byContract.contractId).toBe('CFUND4');
    });
  });
});
