import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import EventLog from '../src/models/EventLog';
import eventLogService from '../src/services/eventLogService';

describe('EventLog Model & Service', () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();
    await mongoose.connect(uri);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  afterEach(async () => {
    await EventLog.deleteMany({});
  });

  describe('Model', () => {
    it('should create an event log entry', async () => {
      const eventData = {
        eventType: 'delivery',
        transactionHash: '0x1234567890abcdef',
        ledgerSequence: 1000,
        contractId: 'C1',
        eventData: { amount: 100, recipient: 'GB123...' },
        status: 'pending' as const,
      };

      const event = new EventLog(eventData);
      await event.save();

      expect(event.id).toBeDefined();
      expect(event.eventType).toBe('delivery');
      expect(event.transactionHash).toBe('0x1234567890abcdef');
      expect(event.ledgerSequence).toBe(1000);
      expect(event.status).toBe('pending');
    });

    it('should reject duplicate transactionHash + eventType via service', async () => {
      const eventData = {
        eventType: 'escrow',
        transactionHash: '0x1234567890abcdef',
        ledgerSequence: 1000,
        status: 'pending' as const,
      };

      // Create first event via service
      await eventLogService.createEventLog(eventData);

      // Try to create duplicate via service - should throw "Event already exists"
      await expect(eventLogService.createEventLog(eventData)).rejects.toThrow(
        'Event already exists',
      );
    });

    it('should require required fields', async () => {
      const event = new EventLog({});
      await expect(event.save()).rejects.toThrow();
    });
  });

  describe('Service', () => {
    it('should create an event log entry', async () => {
      const event = await eventLogService.createEventLog({
        eventType: 'delivery',
        transactionHash: '0x1234567890abcdef',
        ledgerSequence: 1000,
        status: 'pending',
      });

      expect(event).toBeDefined();
      expect(event.eventType).toBe('delivery');
      expect(event.transactionHash).toBe('0x1234567890abcdef');
    });

    it('should mark event as processed', async () => {
      const _event = await eventLogService.createEventLog({
        eventType: 'delivery',
        transactionHash: '0x1234567890abcdef',
        ledgerSequence: 1000,
        status: 'pending',
      });

      const updated = await eventLogService.markAsProcessed('0x1234567890abcdef', 'delivery');

      expect(updated).toBeDefined();
      expect(updated?.status).toBe('processed');
      expect(updated?.processedAt).toBeDefined();
    });

    it('should get last processed ledger', async () => {
      await eventLogService.createEventLog({
        eventType: 'delivery',
        transactionHash: '0x1234567890abcdef',
        ledgerSequence: 1000,
        status: 'processed',
      });

      await eventLogService.createEventLog({
        eventType: 'delivery',
        transactionHash: '0xabcdef1234567890',
        ledgerSequence: 2000,
        status: 'processed',
      });

      const lastLedger = await eventLogService.getLastProcessedLedger();
      expect(lastLedger).toBe(2000);
    });

    it('should check if event exists', async () => {
      await eventLogService.createEventLog({
        eventType: 'delivery',
        transactionHash: '0x1234567890abcdef',
        ledgerSequence: 1000,
        status: 'pending',
      });

      const exists = await EventLog.eventExists('0x1234567890abcdef', 'delivery');
      expect(exists).toBe(true);

      const notExists = await EventLog.eventExists('0xabcdef1234567890', 'delivery');
      expect(notExists).toBe(false);
    });
  });
});
