/**
 * Unit tests for DriverEarningsService — the released-escrow aggregation
 * behind GET /api/v1/drivers/:id/earnings.
 *
 * Escrows and deliveries are persisted in an in-memory MongoDB and the real
 * `$lookup` → `$group` pipeline runs against them, so the totals asserted
 * here are the ones MongoDB actually computes. Buckets are formatted in UTC:
 * days as `YYYY-MM-DD`, weeks as ISO weeks (`%G-W%V`, Monday start, ISO
 * week-year) and months as `YYYY-MM`.
 */

import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { StatusCodes } from 'http-status-codes';
import Delivery, { DeliveryStatus } from '../src/models/Delivery';
import Escrow, { EscrowStatus } from '../src/models/Escrow';
import { DriverEarningsService } from '../src/services/driverEarningsService';

jest.mock('../src/config/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

// ─── Fixtures ───────────────────────────────────────────────────────────────────

const DRIVER = String(new Types.ObjectId());
const OTHER_DRIVER = String(new Types.ObjectId());

/** Persist a completed delivery for `driverId` and the escrow that paid for it. */
const seedEarning = async (
  driverId: string,
  amount: number,
  releasedAt: Date | undefined,
  status: EscrowStatus = EscrowStatus.RELEASED,
): Promise<void> => {
  const delivery = await Delivery.create({ driverId, status: DeliveryStatus.COMPLETED });
  await Escrow.create({
    delivery: delivery._id,
    status,
    amount,
    assetCode: 'XLM',
    ...(releasedAt ? { releasedAt } : {}),
  });
};

const at = (iso: string): Date => new Date(iso);

// ─── Lifecycle ──────────────────────────────────────────────────────────────────

let mongoServer: MongoMemoryServer;
const service = new DriverEarningsService();

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await Promise.all([Delivery.deleteMany({}), Escrow.deleteMany({})]);
});

// ─── Daily grouping ─────────────────────────────────────────────────────────────

describe('DriverEarningsService.getDriverEarnings — daily grouping', () => {
  it('totals each UTC day separately, sorted oldest first', async () => {
    await seedEarning(DRIVER, 12.5, at('2026-03-03T09:00:00Z'));
    await seedEarning(DRIVER, 7.25, at('2026-03-03T23:59:59Z'));
    await seedEarning(DRIVER, 30, at('2026-03-01T12:00:00Z'));
    await seedEarning(DRIVER, 5, at('2026-03-04T00:00:00Z'));

    const result = await service.getDriverEarnings({ driverId: DRIVER });

    expect(result.groupBy).toBe('day');
    expect(result.driverId).toBe(DRIVER);
    expect(result.periods).toEqual([
      { period: '2026-03-01', totalAmount: 30, deliveryCount: 1 },
      { period: '2026-03-03', totalAmount: 19.75, deliveryCount: 2 },
      { period: '2026-03-04', totalAmount: 5, deliveryCount: 1 },
    ]);
    expect(result.summary).toEqual({ totalAmount: 54.75, totalDeliveries: 4 });
  });

  it('only counts escrows whose delivery belongs to the driver', async () => {
    await seedEarning(DRIVER, 10, at('2026-03-01T10:00:00Z'));
    await seedEarning(OTHER_DRIVER, 999, at('2026-03-01T10:00:00Z'));

    const result = await service.getDriverEarnings({ driverId: DRIVER });

    expect(result.periods).toEqual([{ period: '2026-03-01', totalAmount: 10, deliveryCount: 1 }]);
  });

  it('rounds period and summary totals to two decimals', async () => {
    await seedEarning(DRIVER, 0.1, at('2026-03-01T10:00:00Z'));
    await seedEarning(DRIVER, 0.2, at('2026-03-01T11:00:00Z'));
    await seedEarning(DRIVER, 1.005, at('2026-03-02T11:00:00Z'));

    const result = await service.getDriverEarnings({ driverId: DRIVER });

    expect(result.periods[0].totalAmount).toBe(0.3);
    expect(result.summary.totalAmount).toBeCloseTo(1.3, 10);
    expect(Number.isInteger(Math.round(result.summary.totalAmount * 100))).toBe(true);
  });

  it('falls back to updatedAt for a released escrow with no releasedAt', async () => {
    await seedEarning(DRIVER, 4, undefined);

    const result = await service.getDriverEarnings({ driverId: DRIVER });
    const escrow = await Escrow.findOne({}).lean();

    expect(result.periods).toEqual([
      {
        period: escrow!.updatedAt.toISOString().slice(0, 10),
        totalAmount: 4,
        deliveryCount: 1,
      },
    ]);
  });
});

// ─── Weekly and monthly boundaries ──────────────────────────────────────────────

describe('DriverEarningsService.getDriverEarnings — week and month boundaries', () => {
  it('buckets ISO weeks Monday through Sunday', async () => {
    // 2026-01-05 is a Monday: it opens week 02. Sunday 2026-01-11 closes it.
    await seedEarning(DRIVER, 10, at('2026-01-04T23:59:59Z')); // Sun → W01
    await seedEarning(DRIVER, 20, at('2026-01-05T00:00:00Z')); // Mon → W02
    await seedEarning(DRIVER, 30, at('2026-01-11T23:59:59Z')); // Sun → W02
    await seedEarning(DRIVER, 40, at('2026-01-12T00:00:00Z')); // Mon → W03

    const result = await service.getDriverEarnings({ driverId: DRIVER, groupBy: 'week' });

    expect(result.periods).toEqual([
      { period: '2026-W01', totalAmount: 10, deliveryCount: 1 },
      { period: '2026-W02', totalAmount: 50, deliveryCount: 2 },
      { period: '2026-W03', totalAmount: 40, deliveryCount: 1 },
    ]);
  });

  it('labels a week that straddles New Year with its ISO week-year', async () => {
    // Mon 2025-12-29 .. Sun 2026-01-04 is ISO week 2026-W01, even in December.
    await seedEarning(DRIVER, 15, at('2025-12-29T08:00:00Z'));
    await seedEarning(DRIVER, 25, at('2026-01-02T08:00:00Z'));
    // Sun 2025-12-28 is still in 2025-W52.
    await seedEarning(DRIVER, 5, at('2025-12-28T08:00:00Z'));

    const result = await service.getDriverEarnings({ driverId: DRIVER, groupBy: 'week' });

    expect(result.periods).toEqual([
      { period: '2025-W52', totalAmount: 5, deliveryCount: 1 },
      { period: '2026-W01', totalAmount: 40, deliveryCount: 2 },
    ]);
  });

  it('buckets calendar months in UTC', async () => {
    await seedEarning(DRIVER, 100, at('2026-01-31T23:59:59Z'));
    await seedEarning(DRIVER, 50, at('2026-02-01T00:00:00Z'));
    await seedEarning(DRIVER, 25, at('2026-02-28T12:00:00Z'));
    await seedEarning(DRIVER, 10, at('2026-12-31T23:59:59Z'));

    const result = await service.getDriverEarnings({ driverId: DRIVER, groupBy: 'month' });

    expect(result.periods).toEqual([
      { period: '2026-01', totalAmount: 100, deliveryCount: 1 },
      { period: '2026-02', totalAmount: 75, deliveryCount: 2 },
      { period: '2026-12', totalAmount: 10, deliveryCount: 1 },
    ]);
    expect(result.summary).toEqual({ totalAmount: 185, totalDeliveries: 4 });
  });

  it('gives the same summary whichever grouping is used', async () => {
    await seedEarning(DRIVER, 11, at('2026-01-03T10:00:00Z'));
    await seedEarning(DRIVER, 22, at('2026-01-20T10:00:00Z'));
    await seedEarning(DRIVER, 33, at('2026-02-09T10:00:00Z'));

    const summaries = await Promise.all(
      (['day', 'week', 'month'] as const).map(
        async (groupBy) => (await service.getDriverEarnings({ driverId: DRIVER, groupBy })).summary,
      ),
    );

    expect(summaries).toEqual([
      { totalAmount: 66, totalDeliveries: 3 },
      { totalAmount: 66, totalDeliveries: 3 },
      { totalAmount: 66, totalDeliveries: 3 },
    ]);
  });
});

// ─── Settled-only and date range ────────────────────────────────────────────────

describe('DriverEarningsService.getDriverEarnings — what counts', () => {
  it('counts only RELEASED escrows', async () => {
    const day = at('2026-03-01T10:00:00Z');
    await seedEarning(DRIVER, 10, day, EscrowStatus.RELEASED);
    await seedEarning(DRIVER, 200, day, EscrowStatus.DISPUTED);
    await seedEarning(DRIVER, 300, day, EscrowStatus.REFUNDED);
    await seedEarning(DRIVER, 400, day, EscrowStatus.LOCKED);
    await seedEarning(DRIVER, 500, day, EscrowStatus.PENDING);
    await seedEarning(DRIVER, 600, day, EscrowStatus.EXPIRED);
    await seedEarning(DRIVER, 700, day, EscrowStatus.RESOLVED);

    const result = await service.getDriverEarnings({ driverId: DRIVER });

    expect(result.periods).toEqual([{ period: '2026-03-01', totalAmount: 10, deliveryCount: 1 }]);
    expect(result.summary).toEqual({ totalAmount: 10, totalDeliveries: 1 });
  });

  it('ignores a released escrow whose delivery no longer exists', async () => {
    await seedEarning(DRIVER, 10, at('2026-03-01T10:00:00Z'));
    await Escrow.create({
      delivery: new Types.ObjectId(),
      status: EscrowStatus.RELEASED,
      amount: 90,
      assetCode: 'XLM',
      releasedAt: at('2026-03-01T10:00:00Z'),
    });

    const result = await service.getDriverEarnings({ driverId: DRIVER });

    expect(result.summary).toEqual({ totalAmount: 10, totalDeliveries: 1 });
  });

  it('applies startDate and endDate inclusively to releasedAt', async () => {
    await seedEarning(DRIVER, 1, at('2026-02-28T23:59:59Z'));
    await seedEarning(DRIVER, 2, at('2026-03-01T00:00:00Z'));
    await seedEarning(DRIVER, 3, at('2026-03-15T00:00:00Z'));
    await seedEarning(DRIVER, 4, at('2026-03-31T23:59:59Z'));
    await seedEarning(DRIVER, 5, at('2026-04-01T00:00:00Z'));

    const result = await service.getDriverEarnings({
      driverId: DRIVER,
      groupBy: 'month',
      startDate: at('2026-03-01T00:00:00Z'),
      endDate: at('2026-03-31T23:59:59Z'),
    });

    expect(result.periods).toEqual([{ period: '2026-03', totalAmount: 9, deliveryCount: 3 }]);
  });

  it('supports an open-ended range on either side', async () => {
    await seedEarning(DRIVER, 1, at('2026-01-01T00:00:00Z'));
    await seedEarning(DRIVER, 2, at('2026-06-01T00:00:00Z'));

    const from = await service.getDriverEarnings({
      driverId: DRIVER,
      startDate: at('2026-03-01T00:00:00Z'),
    });
    const until = await service.getDriverEarnings({
      driverId: DRIVER,
      endDate: at('2026-03-01T00:00:00Z'),
    });

    expect(from.summary).toEqual({ totalAmount: 2, totalDeliveries: 1 });
    expect(until.summary).toEqual({ totalAmount: 1, totalDeliveries: 1 });
  });
});

// ─── Zero earnings ──────────────────────────────────────────────────────────────

describe('DriverEarningsService.getDriverEarnings — zero earnings', () => {
  it.each(['day', 'week', 'month'] as const)(
    'returns empty periods and a zeroed summary for a driver with no earnings (%s)',
    async (groupBy) => {
      // Someone else has earnings; this driver has none.
      await seedEarning(OTHER_DRIVER, 50, at('2026-03-01T10:00:00Z'));

      const result = await service.getDriverEarnings({ driverId: DRIVER, groupBy });

      expect(result).toEqual({
        driverId: DRIVER,
        groupBy,
        periods: [],
        summary: { totalAmount: 0, totalDeliveries: 0 },
      });
    },
  );

  it('returns a zeroed response when the range holds no earnings', async () => {
    await seedEarning(DRIVER, 50, at('2026-03-01T10:00:00Z'));

    const result = await service.getDriverEarnings({
      driverId: DRIVER,
      startDate: at('2026-04-01T00:00:00Z'),
      endDate: at('2026-04-30T23:59:59Z'),
    });

    expect(result.periods).toEqual([]);
    expect(result.summary).toEqual({ totalAmount: 0, totalDeliveries: 0 });
  });
});

// ─── Validation ─────────────────────────────────────────────────────────────────

describe('DriverEarningsService — validation', () => {
  it.each(['', '   '])('rejects a blank driverId (%j)', async (driverId) => {
    await expect(service.getDriverEarnings({ driverId })).rejects.toMatchObject({
      statusCode: StatusCodes.BAD_REQUEST,
    });
  });

  it('rejects an unknown groupBy', async () => {
    await expect(
      service.getDriverEarnings({
        driverId: DRIVER,
        groupBy: 'year' as unknown as 'day',
      }),
    ).rejects.toMatchObject({ statusCode: StatusCodes.BAD_REQUEST });
  });

  it('rejects a startDate after endDate', async () => {
    await expect(
      service.getDriverEarnings({
        driverId: DRIVER,
        startDate: at('2026-03-02T00:00:00Z'),
        endDate: at('2026-03-01T00:00:00Z'),
      }),
    ).rejects.toMatchObject({ statusCode: StatusCodes.BAD_REQUEST });
  });

  it('accepts a single-instant range where startDate equals endDate', async () => {
    const instant = at('2026-03-01T10:00:00Z');
    await seedEarning(DRIVER, 8, instant);

    const result = await service.getDriverEarnings({
      driverId: DRIVER,
      startDate: instant,
      endDate: instant,
    });

    expect(result.summary).toEqual({ totalAmount: 8, totalDeliveries: 1 });
  });

  it('assertValidDriverId accepts an ObjectId and rejects anything else', () => {
    expect(() => service.assertValidDriverId(DRIVER)).not.toThrow();
    expect(() => service.assertValidDriverId('driver-42')).toThrow(
      expect.objectContaining({ statusCode: StatusCodes.BAD_REQUEST }),
    );
  });
});
