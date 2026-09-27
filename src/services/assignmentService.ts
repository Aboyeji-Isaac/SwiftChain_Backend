/**
 * assignmentService.ts
 *
 * Automates driver assignment for a funded delivery: finds the nearest
 * available driver via the `DriverLocation` 2dsphere index and assigns them.
 *
 * ── Race-condition handling ──────────────────────────────────────────────────
 * Two problems need independent guards:
 *
 *  1. Two deliveries racing for the same driver. Solved with an atomic
 *     claim — `findOneAndUpdate({ driverId, isAvailable: true }, { $set:
 *     { isAvailable: false, ... } })` — rather than a read-then-write. Mongo
 *     serializes the update per document, so only one caller's filter can
 *     match `isAvailable: true` at a time; the loser's `findOneAndUpdate`
 *     returns `null` and the search simply moves to the next-nearest
 *     candidate instead of retrying the same driver.
 *
 *  2. Two requests racing to assign *the same delivery* (e.g. a manual
 *     retrigger overlapping the auto-assignment sweep). Solved with a
 *     Redis distributed lock scoped to the delivery id, mirroring the
 *     pattern `config/redis.ts#withLock` already establishes for escrow
 *     release.
 *
 * If a driver is claimed but the subsequent `deliveryService.assignDriver`
 * call fails (e.g. the escrow guard rejects it), the claim is rolled back so
 * the driver is not stranded as unavailable for a delivery they were never
 * actually assigned to.
 *
 * ── Fallback ──────────────────────────────────────────────────────────────────
 * If no driver is claimed within the starting radius, the search radius is
 * doubled up to `ASSIGNMENT_RADIUS_EXPANSION_STEPS` times (capped at
 * `DRIVER_PROXIMITY_MAX_RADIUS_M`). If every expansion is exhausted, the
 * delivery is left in its current status for a later attempt (manual retry
 * or the next `autoAssignmentJob` sweep tick) rather than failing hard.
 */

import { StatusCodes } from 'http-status-codes';
import { Types } from 'mongoose';
import Delivery, { IDelivery, DeliveryStatus } from '../models/Delivery';
import { DriverLocation } from '../models/DriverLocation';
import { driverLocationService, NearbyDriver } from './driverLocationService';
import { deliveryService } from './delivery.service';
import { withLock } from '../config/redis';
import AppError from '../utils/AppError';
import logger from '../config/logger';
import env from '../config/env';

// ─── DTOs ──────────────────────────────────────────────────────────────────────

export interface AssignNearestDriverResult {
  assigned: boolean;
  delivery?: IDelivery;
  driverId?: string;
  distanceMeters?: number;
  /** Radius, in metres, that finally produced a claimed driver (or the max searched). */
  radiusMeters: number;
  /** Populated when `assigned` is false. */
  reason?: string;
}

// ─── Service ───────────────────────────────────────────────────────────────────

export class AssignmentService {
  /**
   * Find and assign the nearest available driver to a delivery.
   *
   * @throws {AppError} 400 — invalid delivery id, or the delivery has no
   *         pickup coordinates to search from.
   * @throws {AppError} 404 — delivery not found.
   */
  async assignNearestDriver(deliveryId: string): Promise<AssignNearestDriverResult> {
    if (!Types.ObjectId.isValid(deliveryId)) {
      throw new AppError('Invalid delivery ID', StatusCodes.BAD_REQUEST);
    }

    return withLock(`assignment:delivery:${deliveryId}`, async () => {
      const delivery = await Delivery.findById(deliveryId);
      if (!delivery) {
        throw new AppError('Delivery not found', StatusCodes.NOT_FOUND);
      }

      if (delivery.driverId) {
        return {
          assigned: false,
          radiusMeters: 0,
          reason: 'Delivery already has a driver assigned.',
        };
      }

      const center = delivery.pickupCoordinates;
      if (!center || !Number.isFinite(center.lat) || !Number.isFinite(center.lng)) {
        throw new AppError(
          'Delivery has no pickup coordinates to search from.',
          StatusCodes.BAD_REQUEST,
        );
      }

      return this.searchAndClaim(delivery, center);
    });
  }

  /**
   * Expand the search radius step by step, attempting to claim the nearest
   * candidate at each step, until a driver is claimed and assigned or every
   * expansion is exhausted.
   */
  private async searchAndClaim(
    delivery: IDelivery,
    center: { lat: number; lng: number },
  ): Promise<AssignNearestDriverResult> {
    let radiusMeters = env.DRIVER_PROXIMITY_DEFAULT_RADIUS_M;
    const maxRadiusMeters = env.DRIVER_PROXIMITY_MAX_RADIUS_M;
    const maxSteps = env.ASSIGNMENT_RADIUS_EXPANSION_STEPS;

    for (let step = 0; step <= maxSteps; step += 1) {
      const { drivers } = await driverLocationService.findNearbyDrivers({
        lat: center.lat,
        lng: center.lng,
        radiusMeters,
        availableOnly: true,
        status: 'online',
      });

      const claimed = await this.claimFirstAvailable(drivers);
      if (claimed) {
        try {
          const updated = await deliveryService.assignDriver({
            deliveryId: String(delivery._id),
            driverId: claimed.driverId,
          });

          logger.info(
            `[AssignmentService] Assigned nearest driver — delivery=${String(delivery._id)} ` +
              `driver=${claimed.driverId} distance=${claimed.distanceMeters}m radius=${radiusMeters}m`,
          );

          return {
            assigned: true,
            delivery: updated,
            driverId: claimed.driverId,
            distanceMeters: claimed.distanceMeters,
            radiusMeters,
          };
        } catch (error) {
          // The delivery could not actually be assigned (e.g. escrow not
          // locked) — release the driver so they are not stranded.
          await this.releaseClaim(claimed.driverId);
          throw error;
        }
      }

      if (radiusMeters >= maxRadiusMeters) break;
      radiusMeters = Math.min(radiusMeters * 2, maxRadiusMeters);
    }

    logger.warn(
      `[AssignmentService] No driver available for delivery=${String(delivery._id)} ` +
        `after searching up to ${radiusMeters}m`,
    );

    return {
      assigned: false,
      radiusMeters,
      reason: 'No available driver was found within the maximum search radius.',
    };
  }

  /**
   * Walk candidates nearest-first, atomically claiming the first one still
   * available. Losing a claim to a concurrent request simply advances to
   * the next candidate rather than failing the whole search.
   */
  private async claimFirstAvailable(candidates: NearbyDriver[]): Promise<NearbyDriver | null> {
    for (const candidate of candidates) {
      const claimed = await DriverLocation.findOneAndUpdate(
        { driverId: candidate.driverId, isAvailable: true },
        { $set: { isAvailable: false, status: 'on_delivery' } },
        { new: true },
      ).exec();

      if (claimed) {
        return candidate;
      }
      // Another request claimed this driver first — try the next nearest.
    }
    return null;
  }

  /** Revert an atomic claim when the follow-up assignment write failed. */
  private async releaseClaim(driverId: string): Promise<void> {
    try {
      await DriverLocation.findOneAndUpdate(
        { driverId },
        { $set: { isAvailable: true, status: 'online' } },
      ).exec();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error(
        `[AssignmentService] Failed to release claim for driver=${driverId} after a failed assignment: ${message}`,
      );
    }
  }

  /**
   * Sweep funded deliveries with no driver assigned and attempt to assign
   * each one. Used by the auto-assignment cron job; failures on one
   * delivery never stop the sweep from processing the rest.
   */
  async autoAssignPendingDeliveries(limit = 25): Promise<{ attempted: number; assigned: number }> {
    const candidates = await Delivery.find({
      status: DeliveryStatus.FUNDED,
      $or: [{ driverId: { $exists: false } }, { driverId: null }, { driverId: '' }],
    })
      .sort({ createdAt: 1 })
      .limit(limit);

    let assigned = 0;

    for (const delivery of candidates) {
      try {
        const result = await this.assignNearestDriver(String(delivery._id));
        if (result.assigned) assigned += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        logger.warn(
          `[AssignmentService] Auto-assignment failed for delivery=${String(
            delivery._id,
          )}: ${message}`,
        );
      }
    }

    return { attempted: candidates.length, assigned };
  }
}

export const assignmentService = new AssignmentService();
export default assignmentService;
