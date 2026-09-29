/**
 * driverEarningsService.ts
 *
 * Builds a driver's earnings ledger from resolved (released) Escrow
 * documents — the escrow record is the source of truth for what a driver
 * was actually paid, rather than deriving an amount from the Delivery
 * document.
 *
 * `Escrow.delivery` references the `Delivery` that owns a `driverId`
 * string field, so the aggregation joins the two collections to filter by
 * driver before grouping by period.
 */

import { StatusCodes } from 'http-status-codes';
import { PipelineStage, Types } from 'mongoose';
import Escrow, { EscrowStatus } from '../models/Escrow';
import AppError from '../utils/AppError';

// ─── Types ────────────────────────────────────────────────────────────────────

export type EarningsGroupBy = 'day' | 'week' | 'month';

export interface GetDriverEarningsQuery {
  driverId: string;
  groupBy?: EarningsGroupBy;
  startDate?: Date;
  endDate?: Date;
}

export interface EarningsPeriod {
  /** `YYYY-MM-DD`, `YYYY-Www` (ISO week), or `YYYY-MM` depending on `groupBy`. */
  period: string;
  totalAmount: number;
  deliveryCount: number;
}

export interface DriverEarningsResult {
  driverId: string;
  groupBy: EarningsGroupBy;
  periods: EarningsPeriod[];
  summary: {
    totalAmount: number;
    totalDeliveries: number;
  };
}

interface EarningsAggregateRow {
  _id: string;
  totalAmount: number;
  deliveryCount: number;
}

// ─── Date-truncation formats per grouping ──────────────────────────────────────

const DATE_FORMATS: Record<EarningsGroupBy, string> = {
  day: '%Y-%m-%d',
  week: '%G-W%V',
  month: '%Y-%m',
};

// ─── Service ───────────────────────────────────────────────────────────────────

export class DriverEarningsService {
  /**
   * Aggregate a driver's earnings from released escrows, bucketed by day,
   * week, or month.
   *
   * @throws {AppError} 400 — invalid driverId or date range.
   */
  async getDriverEarnings(query: GetDriverEarningsQuery): Promise<DriverEarningsResult> {
    const { driverId } = query;

    if (!driverId || !driverId.trim()) {
      throw new AppError('driverId is required.', StatusCodes.BAD_REQUEST);
    }

    const groupBy = query.groupBy ?? 'day';
    if (!DATE_FORMATS[groupBy]) {
      throw new AppError('groupBy must be one of: day, week, month.', StatusCodes.BAD_REQUEST);
    }

    if (query.startDate && query.endDate && query.startDate > query.endDate) {
      throw new AppError('startDate must be before endDate.', StatusCodes.BAD_REQUEST);
    }

    const releasedAtMatch: Record<string, Date> = {};
    if (query.startDate) releasedAtMatch.$gte = query.startDate;
    if (query.endDate) releasedAtMatch.$lte = query.endDate;

    const pipeline: PipelineStage[] = [
      { $match: { status: EscrowStatus.RELEASED } },
      {
        $lookup: {
          from: 'deliveries',
          localField: 'delivery',
          foreignField: '_id',
          as: 'deliveryDoc',
        },
      },
      { $unwind: '$deliveryDoc' },
      {
        $match: {
          'deliveryDoc.driverId': driverId,
          ...(Object.keys(releasedAtMatch).length > 0 ? { releasedAt: releasedAtMatch } : {}),
        },
      },
      {
        $group: {
          _id: {
            $dateToString: {
              format: DATE_FORMATS[groupBy],
              date: { $ifNull: ['$releasedAt', '$updatedAt'] },
            },
          },
          totalAmount: { $sum: '$amount' },
          deliveryCount: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ];

    const rows = await Escrow.aggregate<EarningsAggregateRow>(pipeline);

    const periods: EarningsPeriod[] = rows.map((row) => ({
      period: row._id,
      totalAmount: Math.round(row.totalAmount * 100) / 100,
      deliveryCount: row.deliveryCount,
    }));

    const summary = periods.reduce(
      (acc, period) => ({
        totalAmount: Math.round((acc.totalAmount + period.totalAmount) * 100) / 100,
        totalDeliveries: acc.totalDeliveries + period.deliveryCount,
      }),
      { totalAmount: 0, totalDeliveries: 0 },
    );

    return { driverId, groupBy, periods, summary };
  }

  /** Validate a Mongo ObjectId supplied as a route param, for callers that need it. */
  assertValidDriverId(driverId: string): void {
    if (!Types.ObjectId.isValid(driverId)) {
      throw new AppError('Invalid driver ID', StatusCodes.BAD_REQUEST);
    }
  }
}

export const driverEarningsService = new DriverEarningsService();
export default driverEarningsService;
