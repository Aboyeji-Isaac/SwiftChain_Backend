/**
 * driverRatingService.ts
 *
 * Business logic for the driver penalty & rating system.
 *
 * Layering: controllers call into this service; only this service touches the
 * `DriverProfile` and `Delivery` models for rating purposes. Every number
 * returned to a caller is read from MongoDB — nothing here fabricates a
 * delivery, a duration, or a score.
 *
 * The engine works in three steps:
 *   1. Collect a driver's delivery history from the `deliveries` collection
 *      (completed, late and cancelled counts).
 *   2. Derive a 0–5 rating from the late-delivery and cancellation rates.
 *   3. Persist the rating on the `DriverProfile` and, when the score is
 *      extremely low, apply a temporary suspension.
 */

import { StatusCodes } from 'http-status-codes';
import { PipelineStage, Types } from 'mongoose';
import Delivery, { DeliveryStatus } from '../models/Delivery';
import DriverProfile from '../models/DriverProfile';
import {
  computeDriverRating,
  DRIVER_RATING_RULES,
  DriverRatingMetrics,
  resolveSuspension,
} from '../interfaces/IDriverProfile';
import AppError from '../utils/AppError';
import logger from '../config/logger';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Delivery-history counters read from the database for one driver. */
export interface DriverRatingMetricsResult extends DriverRatingMetrics {
  lateDeliveryRate: number;
  cancellationRate: number;
}

/** Full rating snapshot returned to the API layer. */
export interface DriverRatingResult {
  driverId: string;
  rating: number;
  reputationPoints: number;
  tier: string;
  totalDeliveries: number;
  completedDeliveries: number;
  delayedDeliveries: number;
  cancelledDeliveries: number;
  lateDeliveryRate: number;
  cancellationRate: number;
  isSuspended: boolean;
  suspendedUntil: Date | null;
  suspensionReason: string | null;
  /** True when this evaluation applied (or extended) a suspension. */
  penaltyApplied: boolean;
  lastRatingUpdate: Date | null;
}

/** Outcome of a fleet-wide recalculation sweep. */
export interface RecalculateAllResult {
  /** Drivers whose history was examined. */
  processed: number;
  /** Drivers for whom a rating was written. */
  updated: number;
  /** Drivers suspended (or re-suspended) by this sweep. */
  suspended: number;
  /** Suspensions lifted because they had lapsed. */
  lifted: number;
  /** Drivers skipped because their evaluation failed. */
  failed: number;
}

/** Shape of one row from the delivery-history aggregation. */
interface DeliveryHistoryRow {
  completed: number;
  cancelled: number;
  delayed: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Round to two decimals so a rating never leaks floating-point noise. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class DriverRatingService {
  /**
   * Read a driver's delivery history from MongoDB and derive the counters the
   * rating formula needs.
   *
   * A delivery counts as *late* when it is completed and its `actualDuration`
   * exceeds the estimate by more than the configured grace ratio. Deliveries
   * missing either duration are never counted as late.
   *
   * @throws {AppError} 400 — malformed driver id.
   * @throws {AppError} 500 — the aggregation failed.
   */
  public async collectDriverMetrics(driverId: string): Promise<DriverRatingMetricsResult> {
    this.assertValidDriverId(driverId);

    const graceMultiplier = 1 + DRIVER_RATING_RULES.DELAY_GRACE_RATIO;

    const pipeline: PipelineStage[] = [
      { $match: { driverId } },
      {
        $group: {
          _id: null,
          completed: {
            $sum: { $cond: [{ $eq: ['$status', DeliveryStatus.COMPLETED] }, 1, 0] },
          },
          cancelled: {
            $sum: { $cond: [{ $eq: ['$status', DeliveryStatus.CANCELLED] }, 1, 0] },
          },
          delayed: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ['$status', DeliveryStatus.COMPLETED] },
                    {
                      $gt: [
                        // A missing duration defaults to -1 / 0 so it can never
                        // satisfy the `$gt`, rather than casting to null.
                        { $ifNull: ['$actualDuration', -1] },
                        {
                          $multiply: [{ $ifNull: ['$estimatedDuration', 0] }, graceMultiplier],
                        },
                      ],
                    },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
    ];

    let rows: DeliveryHistoryRow[];
    try {
      rows = await Delivery.aggregate<DeliveryHistoryRow>(pipeline).exec();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        `[DriverRatingService] Failed to aggregate delivery history for ${driverId}: ${message}`,
      );
      throw new AppError(
        'Unable to compute the driver rating from delivery history.',
        StatusCodes.INTERNAL_SERVER_ERROR,
      );
    }

    const row = rows[0] ?? { completed: 0, cancelled: 0, delayed: 0 };
    const totalAssignedDeliveries = row.completed + row.cancelled;

    return {
      completedDeliveries: row.completed,
      delayedDeliveries: row.delayed,
      cancelledDeliveries: row.cancelled,
      totalAssignedDeliveries,
      lateDeliveryRate: row.completed > 0 ? round2(row.delayed / row.completed) : 0,
      cancellationRate:
        totalAssignedDeliveries > 0 ? round2(row.cancelled / totalAssignedDeliveries) : 0,
    };
  }

  /**
   * Recompute a driver's rating from their delivery history, persist it and
   * apply a temporary suspension when the score is extremely low.
   *
   * The `DriverProfile` is created on first evaluation, so a driver who has
   * completed work but has no profile yet is still scored.
   *
   * @throws {AppError} 400 — malformed driver id.
   */
  public async evaluateDriverRating(driverId: string): Promise<DriverRatingResult> {
    this.assertValidDriverId(driverId);

    const metrics = await this.collectDriverMetrics(driverId);
    const rating = computeDriverRating(metrics);
    const suspension = resolveSuspension(rating, metrics.completedDeliveries);
    const now = new Date();

    const setFields: Record<string, unknown> = {
      rating,
      delayedDeliveries: metrics.delayedDeliveries,
      cancelledDeliveries: metrics.cancelledDeliveries,
      completedDeliveries: metrics.completedDeliveries,
      totalDeliveries: metrics.totalAssignedDeliveries,
      lastRatingUpdate: now,
    };

    if (suspension) {
      setFields.isSuspended = true;
      setFields.suspendedUntil = suspension.suspendedUntil;
      setFields.suspensionReason = suspension.reason;
    }

    const profile = await DriverProfile.findOneAndUpdate(
      { userId: driverId },
      { $set: setFields },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
        runValidators: true,
      },
    ).exec();

    if (!profile) {
      throw new AppError('Driver profile could not be updated.', StatusCodes.INTERNAL_SERVER_ERROR);
    }

    if (suspension) {
      logger.warn(
        `[DriverRatingService] Driver ${driverId} penalised — rating=${rating}, ` +
          `suspendedUntil=${suspension.suspendedUntil.toISOString()}`,
      );
    }

    return this.toResult(
      profile.toObject() as Record<string, unknown>,
      driverId,
      Boolean(suspension),
    );
  }

  /**
   * Fetch the stored rating snapshot for a driver without recomputing it.
   *
   * @throws {AppError} 400 — malformed driver id.
   * @throws {AppError} 404 — the driver has no profile on record.
   */
  public async getDriverRating(driverId: string): Promise<DriverRatingResult> {
    this.assertValidDriverId(driverId);

    const profile = await DriverProfile.findOne({ userId: driverId }).exec();
    if (!profile) {
      throw new AppError(`No rating on record for driver ${driverId}.`, StatusCodes.NOT_FOUND);
    }

    return this.toResult(profile.toObject() as Record<string, unknown>, driverId, false);
  }

  /**
   * Lift every suspension whose expiry has passed, restoring drivers to
   * active status. Safe to call repeatedly.
   *
   * @returns The number of profiles reactivated.
   */
  public async liftExpiredSuspensions(now: Date = new Date()): Promise<number> {
    const result = await DriverProfile.updateMany(
      { isSuspended: true, suspendedUntil: { $lte: now } },
      { $set: { isSuspended: false, suspendedUntil: null }, $unset: { suspensionReason: '' } },
    ).exec();

    if (result.modifiedCount > 0) {
      logger.info(
        `[DriverRatingService] Lifted ${result.modifiedCount} expired driver suspension(s).`,
      );
    }
    return result.modifiedCount;
  }

  /**
   * Recalculate every driver that has ever been assigned a delivery.
   *
   * Intended to run from the scheduled sweep in
   * `src/jobs/driverRatingJob.ts`, so ratings stay current without a client
   * triggering each evaluation. A failure on one driver never aborts the
   * sweep — the error is logged and counted.
   */
  public async recalculateAllDriverRatings(): Promise<RecalculateAllResult> {
    const lifted = await this.liftExpiredSuspensions();

    const driverIds = (await Delivery.distinct('driverId', {
      driverId: { $type: 'string', $ne: '' },
    })) as string[];

    const summary: RecalculateAllResult = {
      processed: driverIds.length,
      updated: 0,
      suspended: 0,
      lifted,
      failed: 0,
    };

    for (const driverId of driverIds) {
      try {
        const result = await this.evaluateDriverRating(driverId);
        summary.updated += 1;
        if (result.penaltyApplied) summary.suspended += 1;
      } catch (error) {
        summary.failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[DriverRatingService] Failed to rate driver ${driverId}: ${message}`);
      }
    }

    logger.info(
      `[DriverRatingService] Sweep complete — processed=${summary.processed} ` +
        `updated=${summary.updated} suspended=${summary.suspended} ` +
        `lifted=${summary.lifted} failed=${summary.failed}`,
    );

    return summary;
  }

  /** Validate a driver id supplied as a route parameter. */
  public assertValidDriverId(driverId: string): void {
    if (!driverId || !Types.ObjectId.isValid(driverId)) {
      throw new AppError('Invalid driver ID', StatusCodes.BAD_REQUEST);
    }
  }

  /** Map a persisted profile into the API-facing rating snapshot. */
  private toResult(
    profile: Record<string, unknown>,
    driverId: string,
    penaltyApplied: boolean,
  ): DriverRatingResult {
    const completedDeliveries = Number(profile.completedDeliveries ?? 0);
    const delayedDeliveries = Number(profile.delayedDeliveries ?? 0);
    const cancelledDeliveries = Number(profile.cancelledDeliveries ?? 0);
    const totalDeliveries = Number(profile.totalDeliveries ?? 0);

    return {
      driverId,
      rating: Number(profile.rating ?? DRIVER_RATING_RULES.MAX_RATING),
      reputationPoints: Number(profile.reputationPoints ?? 0),
      tier: String(profile.tier ?? 'bronze'),
      totalDeliveries,
      completedDeliveries,
      delayedDeliveries,
      cancelledDeliveries,
      lateDeliveryRate:
        completedDeliveries > 0 ? round2(delayedDeliveries / completedDeliveries) : 0,
      cancellationRate: totalDeliveries > 0 ? round2(cancelledDeliveries / totalDeliveries) : 0,
      isSuspended: Boolean(profile.isSuspended),
      suspendedUntil: (profile.suspendedUntil as Date | null | undefined) ?? null,
      suspensionReason: (profile.suspensionReason as string | undefined) ?? null,
      penaltyApplied,
      lastRatingUpdate: (profile.lastRatingUpdate as Date | null | undefined) ?? null,
    };
  }
}

export const driverRatingService = new DriverRatingService();
export default driverRatingService;
