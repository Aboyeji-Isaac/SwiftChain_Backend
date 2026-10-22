import { Document, Types } from 'mongoose';

export enum ReputationTier {
  BRONZE = 'bronze',
  SILVER = 'silver',
  GOLD = 'gold',
  PLATINUM = 'platinum',
}

export interface IVehicleDetails {
  make: string;
  model: string;
  year?: number;
  plateNumber: string;
  capacityKg?: number;
}

export interface IDriverProfile extends Document {
  userId: Types.ObjectId;
  reputationPoints: number;
  tier: ReputationTier;
  totalDeliveries: number;
  completedDeliveries: number;
  /**
   * Dynamically computed performance rating, on a 0–5 scale (5 = flawless).
   * Derived from the driver's late-delivery and cancellation rates; see
   * `src/services/driverRatingService.ts`.
   */
  rating: number;
  /** Completed deliveries whose actual duration exceeded the estimate (+ grace). */
  delayedDeliveries: number;
  /** Deliveries the driver abandoned after being assigned. */
  cancelledDeliveries: number;
  /** Whether a rating penalty currently suspends the driver. */
  isSuspended: boolean;
  /** When the temporary suspension lapses; `null` when not suspended. */
  suspendedUntil?: Date | null;
  /** Human-readable reason recorded when the penalty was applied. */
  suspensionReason?: string;
  /** When the rating was last recomputed from delivery history. */
  lastRatingUpdate?: Date | null;
  vehicleDetails?: IVehicleDetails;
  isDeleted?: boolean;
  deletedAt?: Date | null;
  deletedBy?: string;
  createdAt: Date;
  updatedAt: Date;
  softDelete(userId?: string): Promise<this>;
  restore(): Promise<this>;
  /** Flag the profile as suspended until `suspendedUntil`, recording why. */
  applySuspension(suspendedUntil: Date, reason: string): Promise<this>;
  /** Clear an active suspension once it has lapsed. */
  liftSuspension(): Promise<this>;
}

/**
 * Tunable inputs for the driver rating / penalty engine.
 *
 * Every number is a business rule, kept in one place so the rating engine and
 * its tests agree on the exact thresholds that trigger a penalty.
 */
export const DRIVER_RATING_RULES = {
  /** Best possible rating. */
  MAX_RATING: 5,
  /** Worst possible rating (a fully delayed, fully cancelled driver). */
  MIN_RATING: 0,
  /** Rating points deducted when every completed delivery is late. */
  LATE_DELIVERY_PENALTY: 2,
  /** Rating points deducted when every assigned delivery is cancelled. */
  CANCELLATION_PENALTY: 3,
  /** Percentage over the estimate that counts as "on time" (10% = 110% allowed). */
  DELAY_GRACE_RATIO: 0.1,
  /** Ratings strictly below this trigger a temporary suspension. */
  SUSPENSION_RATING_THRESHOLD: 2,
  /** Suspension length, in days, for a rating below the standard threshold. */
  SUSPENSION_DURATION_DAYS: 7,
  /** Ratings at or below this are treated as a severe breach. */
  SEVERE_RATING_THRESHOLD: 1,
  /** Suspension length, in days, for a severe rating. */
  SEVERE_SUSPENSION_DURATION_DAYS: 30,
  /**
   * Minimum completed deliveries before a penalty may be applied. Protects
   * new drivers from being suspended on a single unlucky trip.
   */
  MIN_COMPLETED_FOR_PENALTY: 5,
} as const;

/** Raw delivery-history counters used to derive a driver's rating. */
export interface DriverRatingMetrics {
  completedDeliveries: number;
  delayedDeliveries: number;
  cancelledDeliveries: number;
  totalAssignedDeliveries: number;
}

/** Clamp a value into an inclusive numeric range. */
export function clampRating(value: number): number {
  const { MIN_RATING, MAX_RATING } = DRIVER_RATING_RULES;
  if (Number.isNaN(value)) return MAX_RATING;
  return Math.min(MAX_RATING, Math.max(MIN_RATING, value));
}

/**
 * Compute a driver's 0–5 rating from their delivery history.
 *
 * A driver with no history starts at the maximum rating. Deductions are
 * proportional to the late-delivery and cancellation rates, so a single
 * incident on a long history barely moves the needle while a persistently
 * poor record drives the rating toward zero.
 */
export function computeDriverRating(metrics: DriverRatingMetrics): number {
  const { MAX_RATING, LATE_DELIVERY_PENALTY, CANCELLATION_PENALTY } = DRIVER_RATING_RULES;

  const lateRate =
    metrics.completedDeliveries > 0 ? metrics.delayedDeliveries / metrics.completedDeliveries : 0;
  const cancellationRate =
    metrics.totalAssignedDeliveries > 0
      ? metrics.cancelledDeliveries / metrics.totalAssignedDeliveries
      : 0;

  const rating =
    MAX_RATING - lateRate * LATE_DELIVERY_PENALTY - cancellationRate * CANCELLATION_PENALTY;

  return Math.round(clampRating(rating) * 100) / 100;
}

/**
 * Decide whether a rating warrants a temporary suspension and for how long.
 *
 * Returns `null` when the driver keeps operating — either because the rating
 * is acceptable or because they have not completed enough deliveries for the
 * rating to be statistically meaningful.
 */
export function resolveSuspension(
  rating: number,
  completedDeliveries: number,
): { suspendedUntil: Date; reason: string } | null {
  const rules = DRIVER_RATING_RULES;

  if (completedDeliveries < rules.MIN_COMPLETED_FOR_PENALTY) return null;
  // Below the standard threshold the driver is suspended; at or below the
  // severe threshold the suspension is extended.
  if (rating >= rules.SUSPENSION_RATING_THRESHOLD) return null;

  const isSevere = rating <= rules.SEVERE_RATING_THRESHOLD;
  const days = isSevere ? rules.SEVERE_SUSPENSION_DURATION_DAYS : rules.SUSPENSION_DURATION_DAYS;
  const suspendedUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  return {
    suspendedUntil,
    reason: isSevere
      ? `Driver rating ${rating} is critically low; suspended for ${days} days.`
      : `Driver rating ${rating} is below the ${rules.SUSPENSION_RATING_THRESHOLD} threshold; suspended for ${days} days.`,
  };
}

export const TIER_THRESHOLDS: Record<ReputationTier, number> = {
  [ReputationTier.BRONZE]: 0,
  [ReputationTier.SILVER]: 100,
  [ReputationTier.GOLD]: 500,
  [ReputationTier.PLATINUM]: 1000,
};

export function computeTier(points: number): ReputationTier {
  if (points >= TIER_THRESHOLDS[ReputationTier.PLATINUM]) return ReputationTier.PLATINUM;
  if (points >= TIER_THRESHOLDS[ReputationTier.GOLD]) return ReputationTier.GOLD;
  if (points >= TIER_THRESHOLDS[ReputationTier.SILVER]) return ReputationTier.SILVER;
  return ReputationTier.BRONZE;
}
