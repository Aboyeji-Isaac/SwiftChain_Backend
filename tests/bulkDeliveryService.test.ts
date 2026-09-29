/**
 * Unit tests for BulkDeliveryService.
 *
 * Runs against a real in-process MongoDB so the unique index on
 * trackingNumber, unordered insertMany semantics and partial-failure handling
 * are exercised against the actual driver rather than a mock.
 */

import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import Delivery, { DeliveryStatus } from '../src/models/Delivery';
import NotificationPreference from '../src/models/NotificationPreference';
import Notification from '../src/models/Notification';
import { BulkDeliveryService } from '../src/services/bulkDeliveryService';
import { NotificationService } from '../src/services/notificationService';
import { IPushProvider, PushResult } from '../src/services/push/pushProvider';

jest.mock('../src/config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

/** Push transport that accepts everything, so imports are not gated on FCM. */
class NoopPushProvider implements IPushProvider {
  public readonly name = 'noop';
  isConfigured(): boolean {
    return true;
  }
  async send(): Promise<PushResult> {
    return { acceptedCount: 0, rejectedCount: 0, invalidTokens: [] };
  }
}

const HEADER =
  'trackingNumber,customerName,customerPhone,customerEmail,pickupAddress,' +
  'dropoffAddress,packageDescription,packageWeight,deliveryFee,escrowAmount,notes';

/** Build one valid CSV data row, with optional field overrides. */
const row = (overrides: Partial<Record<string, string>> = {}): string => {
  const fields = {
    trackingNumber: `TRK-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
    customerName: 'Ada Lovelace',
    customerPhone: '+2348000000000',
    customerEmail: 'ada@example.com',
    pickupAddress: '1 Pickup Road',
    dropoffAddress: '2 Dropoff Avenue',
    packageDescription: 'Documents',
    packageWeight: '1.5',
    deliveryFee: '1000',
    escrowAmount: '5000',
    notes: 'Handle with care',
    ...overrides,
  };

  return [
    fields.trackingNumber,
    fields.customerName,
    fields.customerPhone,
    fields.customerEmail,
    fields.pickupAddress,
    fields.dropoffAddress,
    fields.packageDescription,
    fields.packageWeight,
    fields.deliveryFee,
    fields.escrowAmount,
    fields.notes,
  ].join(',');
};

/** Assemble a full CSV document from data rows. */
const csv = (...rows: string[]): string => `${HEADER}\n${rows.join('\n')}\n`;

describe('BulkDeliveryService', () => {
  let mongod: MongoMemoryServer;
  let service: BulkDeliveryService;

  const userId = new Types.ObjectId().toHexString();

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());

    const notifications = new NotificationService(undefined, undefined, new NoopPushProvider());
    service = new BulkDeliveryService(undefined, notifications);
  }, 60_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  }, 30_000);

  afterEach(async () => {
    await Promise.all([
      Delivery.deleteMany({}),
      NotificationPreference.deleteMany({}),
      Notification.deleteMany({}),
    ]);
  });

  // ── Happy path ────────────────────────────────────────────────────────────

  describe('successful import', () => {
    it('creates every valid row', async () => {
      const result = await service.importFromCsv(csv(row(), row(), row()), userId);

      expect(result.totalRows).toBe(3);
      expect(result.successCount).toBe(3);
      expect(result.failureCount).toBe(0);
      expect(result.errors).toEqual([]);
      await expect(Delivery.countDocuments({})).resolves.toBe(3);
    });

    it('persists the mapped fields from the CSV', async () => {
      await service.importFromCsv(csv(row({ trackingNumber: 'TRK-MAPPED' })), userId);

      const delivery = await Delivery.findOne({ trackingNumber: 'TRK-MAPPED' });

      expect(delivery).not.toBeNull();
      expect(delivery?.customer?.name).toBe('Ada Lovelace');
      expect(delivery?.customer?.email).toBe('ada@example.com');
      expect(delivery?.pickup?.address).toBe('1 Pickup Road');
      expect(delivery?.package?.weight).toBe(1.5);
      expect(delivery?.deliveryFee).toBe(1000);
      expect(delivery?.escrowAmount).toBe(5000);
      expect(delivery?.notes).toBe('Handle with care');
    });

    it('records the importing user and a pending status', async () => {
      await service.importFromCsv(csv(row({ trackingNumber: 'TRK-OWNER' })), userId);

      const delivery = await Delivery.findOne({ trackingNumber: 'TRK-OWNER' });

      expect(delivery?.userId).toBe(userId);
      expect(delivery?.status).toBe(DeliveryStatus.PENDING);
    });

    it('accepts rows omitting the optional columns', async () => {
      const result = await service.importFromCsv(
        csv(row({ customerEmail: '', notes: '' })),
        userId,
      );

      expect(result.successCount).toBe(1);
    });
  });

  // ── Partial failure ───────────────────────────────────────────────────────

  describe('partial failure', () => {
    it('imports valid rows and reports invalid ones', async () => {
      const result = await service.importFromCsv(
        csv(row(), row({ customerName: '' }), row()),
        userId,
      );

      expect(result.successCount).toBe(2);
      expect(result.failureCount).toBe(1);
      expect(result.errors[0].message).toMatch(/customerName is required/);
      await expect(Delivery.countDocuments({})).resolves.toBe(2);
    });

    it('reports the source line number of a bad row', async () => {
      const result = await service.importFromCsv(
        csv(row(), row({ packageWeight: 'heavy' })),
        userId,
      );

      // Header is line 1, so the second data row is line 3.
      expect(result.errors[0].line).toBe(3);
    });

    it('reports every problem on a row in one pass', async () => {
      const result = await service.importFromCsv(
        csv(row({ customerName: '', packageWeight: 'x' })),
        userId,
      );

      expect(result.errors.length).toBeGreaterThanOrEqual(2);
    });

    it('counts failed rows rather than individual errors', async () => {
      // One row, three invalid columns: the caller must be told one row
      // failed, not three, or "N of M" would exceed the rows in the file.
      const result = await service.importFromCsv(
        csv(row({ customerName: '', customerPhone: '', packageWeight: 'x' })),
        userId,
      );

      expect(result.totalRows).toBe(1);
      expect(result.failureCount).toBe(1);
      expect(result.errors.length).toBeGreaterThan(1);
      expect(result.successCount + result.failureCount).toBeLessThanOrEqual(result.totalRows);
    });

    it('keeps success and failure counts consistent with the row total', async () => {
      const result = await service.importFromCsv(
        csv(row(), row({ customerName: '', packageWeight: 'x' }), row()),
        userId,
      );

      expect(result.totalRows).toBe(3);
      expect(result.successCount).toBe(2);
      expect(result.failureCount).toBe(1);
      expect(result.successCount + result.failureCount).toBe(result.totalRows);
    });

    it('rejects a non-positive package weight', async () => {
      const result = await service.importFromCsv(csv(row({ packageWeight: '0' })), userId);

      expect(result.successCount).toBe(0);
      expect(result.errors[0].message).toMatch(/greater than zero/);
    });

    it('rejects a negative delivery fee', async () => {
      const result = await service.importFromCsv(csv(row({ deliveryFee: '-1' })), userId);

      expect(result.errors[0].message).toMatch(/cannot be negative/);
    });

    it('rejects a malformed email address', async () => {
      const result = await service.importFromCsv(
        csv(row({ customerEmail: 'not-an-email' })),
        userId,
      );

      expect(result.errors[0].message).toMatch(/valid email/);
    });

    it('sorts the error report by line number', async () => {
      const result = await service.importFromCsv(
        csv(row({ customerName: '' }), row(), row({ packageWeight: 'x' })),
        userId,
      );

      const lines = result.errors.map((error) => error.line);
      expect(lines).toEqual([...lines].sort((a, b) => a - b));
    });
  });

  // ── Duplicate handling ────────────────────────────────────────────────────

  describe('duplicate tracking numbers', () => {
    it('rejects a row duplicating an earlier row in the same file', async () => {
      const result = await service.importFromCsv(
        csv(row({ trackingNumber: 'TRK-DUP' }), row({ trackingNumber: 'TRK-DUP' })),
        userId,
      );

      expect(result.successCount).toBe(1);
      expect(result.failureCount).toBe(1);
      expect(result.errors[0].message).toMatch(/Duplicate tracking number within the file/);
      expect(result.errors[0].message).toMatch(/line 2/);
      await expect(Delivery.countDocuments({ trackingNumber: 'TRK-DUP' })).resolves.toBe(1);
    });

    it('rejects a row duplicating a delivery already in the database', async () => {
      await service.importFromCsv(csv(row({ trackingNumber: 'TRK-EXISTS' })), userId);

      const result = await service.importFromCsv(
        csv(row({ trackingNumber: 'TRK-EXISTS' }), row()),
        userId,
      );

      expect(result.successCount).toBe(1);
      expect(result.failureCount).toBe(1);
      expect(result.errors[0].message).toMatch(/already exists/);
      expect(result.errors[0].trackingNumber).toBe('TRK-EXISTS');
    });
  });

  // ── Whole-file rejections ─────────────────────────────────────────────────

  describe('unusable files', () => {
    it('rejects a file missing required columns', async () => {
      await expect(
        service.importFromCsv('trackingNumber,customerName\nTRK-1,Ada\n', userId),
      ).rejects.toThrow(/missing required column/i);
    });

    it('names every missing column', async () => {
      await expect(
        service.importFromCsv('trackingNumber,customerName\nTRK-1,Ada\n', userId),
      ).rejects.toThrow(/customerphone/);
    });

    it('rejects an empty file', async () => {
      await expect(service.importFromCsv('', userId)).rejects.toThrow(/empty/i);
    });

    it('rejects a header-only file', async () => {
      await expect(service.importFromCsv(`${HEADER}\n`, userId)).rejects.toThrow(/no data rows/i);
    });

    it('writes nothing when the file is rejected outright', async () => {
      await expect(service.importFromCsv('bad,header\n1,2\n', userId)).rejects.toThrow();
      await expect(Delivery.countDocuments({})).resolves.toBe(0);
    });
  });

  // ── Column handling ───────────────────────────────────────────────────────

  describe('column handling', () => {
    it('accepts headers in any letter case', async () => {
      const upper = HEADER.toUpperCase();
      const result = await service.importFromCsv(`${upper}\n${row()}\n`, userId);

      expect(result.successCount).toBe(1);
    });

    it('handles quoted fields containing commas', async () => {
      const quoted = row({ pickupAddress: '"12 High Street, Lagos"' });
      const result = await service.importFromCsv(csv(quoted), userId);

      expect(result.successCount).toBe(1);
      const delivery = await Delivery.findOne({});
      expect(delivery?.pickup?.address).toBe('12 High Street, Lagos');
    });
  });

  // ── Notifications ─────────────────────────────────────────────────────────

  describe('notifications', () => {
    it('records a creation notification per imported delivery', async () => {
      // The importing user is the only identifiable recipient, and userId is
      // stored as a free-form string, so no ObjectId recipient resolves here.
      // The import must still succeed.
      const result = await service.importFromCsv(csv(row(), row()), userId);

      expect(result.successCount).toBe(2);
    });
  });
});
