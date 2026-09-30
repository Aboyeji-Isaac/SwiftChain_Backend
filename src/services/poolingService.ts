/**
 * poolingService.ts
 *
 * Groups nearby pending/funded deliveries into pools and assigns each pool
 * to a single available driver with an optimised stop sequence.
 *
 * Layering: controllers call this service; only this service talks to the
 * Delivery / DriverLocation models. All data is read from MongoDB.
 */

import Delivery, { IDelivery, DeliveryStatus } from '../models/Delivery';
import { DriverLocation } from '../models/DriverLocation';
import { driverLocationService, NearbyDriver } from './driverLocationService';
import { deliveryService } from './delivery.service';
import { routingService } from './routingService';
import { encodeGeohash } from '../utils/geohash';
import logger from '../config/logger';
import env from '../config/env';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Coordinates {
  lat: number;
  lng: number;
}

export interface PoolingOptions {
  /** Max distance (metres) between deliveries to consider them in the same pool. Default 2000. */
  maxProximityMeters?: number;
  /** Maximum deliveries allowed in one pool. Default 5. */
  maxPoolSize?: number;
  /** Statuses that can be pooled. Default: pending + funded. */
  statuses?: DeliveryStatus[];
  /** Optional centre point – only pool deliveries near this location. */
  center?: Coordinates;
  /** Radius around center (metres). Only used when center is provided. */
  radiusMeters?: number;
}

export interface DeliveryPool {
  poolId: string;
  deliveries: IDelivery[];
  centroid: Coordinates;
  /** Ordered sequence of stop points (pickup then drop-off for each delivery). */
  routeSequence: Array<{
    deliveryId: string;
    type: 'pickup' | 'dropoff';
    coordinates: Coordinates;
    address?: string;
  }>;
  totalEstimatedDistanceMeters: number;
  totalEstimatedDurationMinutes: number;
}

export interface AssignPoolResult {
  assigned: boolean;
  pool?: DeliveryPool;
  driverId?: string;
  reason?: string;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class PoolingService {
  private readonly DEFAULT_PROXIMITY_M = 2000;
  private readonly DEFAULT_MAX_POOL_SIZE = 5;

  /**
   * Find pending/funded deliveries and group them into proximity-based pools.
   */
  async createPools(options: PoolingOptions = {}): Promise<DeliveryPool[]> {
    const proximity = options.maxProximityMeters ?? this.DEFAULT_PROXIMITY_M;
    const maxSize = options.maxPoolSize ?? this.DEFAULT_MAX_POOL_SIZE;
    const statuses = options.statuses ?? [DeliveryStatus.PENDING, DeliveryStatus.FUNDED];

    const filter: Record<string, unknown> = {
      status: { $in: statuses },
      isDeleted: { $ne: true },
      $or: [{ driverId: { $exists: false } }, { driverId: null }, { driverId: '' }],
      'pickupCoordinates.lat': { $exists: true, $ne: null },
      'pickupCoordinates.lng': { $exists: true, $ne: null },
    };

    // Optional geographic window
    if (options.center) {
      const deg = options.radiusMeters ? options.radiusMeters / 111_320 : 0.05; // ~5.5 km default
      filter['pickupCoordinates.lat'] = {
        $gte: options.center.lat - deg,
        $lte: options.center.lat + deg,
      };
      filter['pickupCoordinates.lng'] = {
        $gte: options.center.lng - deg,
        $lte: options.center.lng + deg,
      };
    }

    const candidates = await Delivery.find(filter)
      .sort({ createdAt: 1 })
      .limit(200) // safety limit
      .lean()
      .exec();

    if (candidates.length === 0) {
      return [];
    }

    // Simple greedy clustering by pickup proximity
    const pools: DeliveryPool[] = [];
    const used = new Set<string>();

    for (const seed of candidates) {
      const seedId = String(seed._id);
      if (used.has(seedId)) continue;

      const poolDeliveries: IDelivery[] = [seed as IDelivery];
      used.add(seedId);

      const seedPickup = seed.pickupCoordinates!;

      for (const other of candidates) {
        const otherId = String(other._id);
        if (used.has(otherId) || poolDeliveries.length >= maxSize) continue;

        const dist = this.haversineMeters(seedPickup, other.pickupCoordinates!);
        if (dist <= proximity) {
          poolDeliveries.push(other as IDelivery);
          used.add(otherId);
        }
      }

      if (poolDeliveries.length >= 1) {
        const pool = await this.buildPool(poolDeliveries);
        pools.push(pool);
      }
    }

    logger.info(
      `[PoolingService] Created ${pools.length} pool(s) from ${candidates.length} candidates`,
    );
    return pools;
  }

  /**
   * Assign an entire pool to the nearest available driver and update all
   * deliveries in the pool.
   */
  async assignPoolToNearestDriver(pool: DeliveryPool): Promise<AssignPoolResult> {
    if (pool.deliveries.length === 0) {
      return { assigned: false, reason: 'Empty pool' };
    }

    const center = pool.centroid;

    const { drivers } = await driverLocationService.findNearbyDrivers({
      lat: center.lat,
      lng: center.lng,
      radiusMeters: env.DRIVER_PROXIMITY_DEFAULT_RADIUS_M ?? 5000,
      availableOnly: true,
      status: 'online',
    });

    if (drivers.length === 0) {
      return { assigned: false, reason: 'No available driver near the pool centroid' };
    }

    // Claim the nearest driver (same atomic pattern as assignmentService)
    let claimed: NearbyDriver | null = null;
    for (const candidate of drivers) {
      const doc = await DriverLocation.findOneAndUpdate(
        { driverId: candidate.driverId, isAvailable: true },
        { $set: { isAvailable: false, status: 'on_delivery' } },
        { new: true },
      ).exec();

      if (doc) {
        claimed = candidate;
        break;
      }
    }

    if (!claimed) {
      return { assigned: false, reason: 'Could not claim any driver (race condition)' };
    }

    // Assign every delivery in the pool to this driver
    try {
      for (const delivery of pool.deliveries) {
        await deliveryService.assignDriver({
          deliveryId: String(delivery._id),
          driverId: claimed.driverId,
        });
      }

      logger.info(
        `[PoolingService] Assigned pool of ${pool.deliveries.length} deliveries to driver ${claimed.driverId}`,
      );

      return {
        assigned: true,
        pool,
        driverId: claimed.driverId,
      };
    } catch (err) {
      // Roll back the claim
      await DriverLocation.findOneAndUpdate(
        { driverId: claimed.driverId },
        { $set: { isAvailable: true, status: 'online' } },
      ).exec();
      throw err;
    }
  }

  /**
   * Convenience method: create pools and automatically assign each one.
   */
  async poolAndAssign(options: PoolingOptions = {}): Promise<{
    poolsCreated: number;
    poolsAssigned: number;
    results: AssignPoolResult[];
  }> {
    const pools = await this.createPools(options);
    const results: AssignPoolResult[] = [];

    for (const pool of pools) {
      // Only try to assign multi-delivery pools
      if (pool.deliveries.length < 2) continue;

      const result = await this.assignPoolToNearestDriver(pool);
      results.push(result);
    }

    return {
      poolsCreated: pools.length,
      poolsAssigned: results.filter((r) => r.assigned).length,
      results,
    };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async buildPool(deliveries: IDelivery[]): Promise<DeliveryPool> {
    const centroid = this.calculateCentroid(deliveries.map((d) => d.pickupCoordinates!));

    const routeSequence = this.buildNearestNeighbourRoute(deliveries);

    let totalDistance = 0;
    let totalDuration = 0;

    for (let i = 0; i < routeSequence.length - 1; i++) {
      const from = routeSequence[i].coordinates;
      const to = routeSequence[i + 1].coordinates;
      const eta = await routingService.calculateETA({
        pickup: from,
        dropoff: to,
        travelMode: 'driving',
      });
      totalDistance += eta.route.distance;
      totalDuration += eta.estimatedTime;
    }

    return {
      poolId: `pool_${encodeGeohash(centroid.lat, centroid.lng, 6)}_${Date.now()}`,
      deliveries,
      centroid,
      routeSequence,
      totalEstimatedDistanceMeters: Math.round(totalDistance),
      totalEstimatedDurationMinutes: Math.round(totalDuration),
    };
  }

  private calculateCentroid(points: Coordinates[]): Coordinates {
    const n = points.length;
    const sum = points.reduce((acc, p) => ({ lat: acc.lat + p.lat, lng: acc.lng + p.lng }), {
      lat: 0,
      lng: 0,
    });
    return { lat: sum.lat / n, lng: sum.lng / n };
  }

  private buildNearestNeighbourRoute(deliveries: IDelivery[]) {
    type Stop = {
      deliveryId: string;
      type: 'pickup' | 'dropoff';
      coordinates: Coordinates;
      address?: string;
    };

    const stops: Stop[] = [];
    for (const d of deliveries) {
      stops.push({
        deliveryId: String(d._id),
        type: 'pickup',
        coordinates: d.pickupCoordinates!,
        address: d.pickupCoordinates?.address,
      });
      stops.push({
        deliveryId: String(d._id),
        type: 'dropoff',
        coordinates: d.dropoffCoordinates!,
        address: d.dropoffCoordinates?.address,
      });
    }

    // Nearest-neighbour starting from the first pickup
    const sequence: Stop[] = [];
    const remaining = [...stops];
    let current = remaining.shift()!;
    sequence.push(current);

    while (remaining.length > 0) {
      let nearestIdx = 0;
      let nearestDist = Infinity;

      for (let i = 0; i < remaining.length; i++) {
        // Cannot drop off before picking up the same delivery
        if (
          remaining[i].type === 'dropoff' &&
          !sequence.some((s) => s.deliveryId === remaining[i].deliveryId && s.type === 'pickup')
        ) {
          continue;
        }

        const dist = this.haversineMeters(current.coordinates, remaining[i].coordinates);
        if (dist < nearestDist) {
          nearestDist = dist;
          nearestIdx = i;
        }
      }

      current = remaining.splice(nearestIdx, 1)[0];
      sequence.push(current);
    }

    return sequence;
  }

  private haversineMeters(a: Coordinates, b: Coordinates): number {
    const R = 6371000;
    const toRad = (deg: number) => (deg * Math.PI) / 180;

    const dLat = toRad(b.lat - a.lat);
    let dLng = b.lng - a.lng;
    if (dLng > 180) dLng -= 360;
    else if (dLng < -180) dLng += 360;
    dLng = toRad(dLng);

    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);

    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

    return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }
}

export const poolingService = new PoolingService();
export default poolingService;
