/**
 * driverLocationService.ts
 *
 * Business logic for driver positions and proximity search.
 *
 * Layering: controllers call into this service; only this service touches the
 * `DriverLocation` model. Every value returned to a caller is read from
 * MongoDB — nothing here fabricates a driver, a distance, or a coordinate.
 *
 * ── Why `$geoNear` ───────────────────────────────────────────────────────────
 * Proximity search runs as a `$geoNear` aggregation rather than a `$near`
 * find(), for two reasons:
 *
 *   1. `$geoNear` returns the computed distance for each document
 *      (`distanceField`), so the caller gets real distances from the index
 *      walk instead of the service recomputing haversine for every result.
 *
 *   2. Its `query` option is applied *during* the index walk. A `$near` find
 *      with an extra filter walks outward through every driver in the radius
 *      and discards the non-matching ones afterwards — on a dense city that is
 *      most of the work. Pushing the availability filter into `$geoNear` lets
 *      the compound `{ isAvailable, status, location }` index skip them.
 *
 * `$geoNear` must be the first stage of its pipeline, and requires a 2dsphere
 * index to exist on the collection; both invariants are held here.
 */

import { StatusCodes } from 'http-status-codes';
import { PipelineStage, Types } from 'mongoose';
import {
  DriverLocation,
  IDriverLocation,
  DriverAvailabilityStatus,
} from '../models/DriverLocation';
import AppError from '../utils/AppError';
import logger from '../config/logger';
import env from '../config/env';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Query accepted by {@link DriverLocationService.findNearbyDrivers}. */
export interface NearbyDriversQuery {
  /** Search-centre latitude, in decimal degrees. */
  lat: number;
  /** Search-centre longitude, in decimal degrees. */
  lng: number;
  /** Search radius in metres. Defaults to `DRIVER_PROXIMITY_DEFAULT_RADIUS_M`. */
  radiusMeters?: number;
  /** Maximum drivers to return. Defaults to `DRIVER_PROXIMITY_MAX_RESULTS`. */
  limit?: number;
  /** When true (the default), only drivers marked available are returned. */
  availableOnly?: boolean;
  /** Restrict to a specific availability state. */
  status?: DriverAvailabilityStatus;
}

/** One driver in a proximity result, with the distance MongoDB computed. */
export interface NearbyDriver {
  driverId: string;
  /** Straight-line distance from the search centre, in metres. */
  distanceMeters: number;
  lat: number;
  lng: number;
  isAvailable: boolean;
  status: DriverAvailabilityStatus;
  heading?: number;
  speed?: number;
  accuracy?: number;
  currentDeliveryId?: string;
  recordedAt: Date;
}

/** Result envelope, including the parameters actually applied. */
export interface NearbyDriversResult {
  drivers: NearbyDriver[];
  /** Number of drivers returned. */
  count: number;
  /** Radius actually used after clamping, in metres. */
  radiusMeters: number;
  /** Search centre echoed back, so a client can confirm what was queried. */
  center: { lat: number; lng: number };
}

/** Payload accepted when a driver reports a new position. */
export interface UpsertDriverLocationInput {
  driverId: string;
  lat: number;
  lng: number;
  isAvailable?: boolean;
  status?: DriverAvailabilityStatus;
  heading?: number;
  speed?: number;
  accuracy?: number;
  currentDeliveryId?: string | null;
  recordedAt?: Date;
}

/** Shape returned by the `$geoNear` pipeline before it is mapped for the API. */
interface GeoNearRow {
  _id: Types.ObjectId;
  driverId: Types.ObjectId;
  location: { type: 'Point'; coordinates: [number, number] };
  isAvailable: boolean;
  status: DriverAvailabilityStatus;
  heading?: number;
  speed?: number;
  accuracy?: number;
  currentDeliveryId?: Types.ObjectId | null;
  recordedAt: Date;
  distanceMeters: number;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class DriverLocationService {
  /**
   * Find drivers near a point, nearest first.
   *
   * @param query - Search centre, radius and filters.
   * @returns Matching drivers with their distance from the centre.
   *
   * @throws {AppError} 400 — coordinates, radius or limit outside valid bounds.
   * @throws {AppError} 500 — the query failed at the database.
   */
  public async findNearbyDrivers(query: NearbyDriversQuery): Promise<NearbyDriversResult> {
    const { lat, lng } = this.assertValidCoordinates(query.lat, query.lng);
    const radiusMeters = this.resolveRadius(query.radiusMeters);
    const limit = this.resolveLimit(query.limit);
    const availableOnly = query.availableOnly ?? true;

    // Filters applied inside the geo index walk rather than after it.
    const filter: Record<string, unknown> = {};
    if (availableOnly) filter.isAvailable = true;
    if (query.status) filter.status = query.status;

    const pipeline: PipelineStage[] = [
      {
        $geoNear: {
          near: { type: 'Point', coordinates: [lng, lat] },
          distanceField: 'distanceMeters',
          maxDistance: radiusMeters,
          spherical: true,
          query: filter,
          key: 'location',
        },
      },
      { $limit: limit },
      {
        $project: {
          driverId: 1,
          location: 1,
          isAvailable: 1,
          status: 1,
          heading: 1,
          speed: 1,
          accuracy: 1,
          currentDeliveryId: 1,
          recordedAt: 1,
          distanceMeters: 1,
        },
      },
    ];

    const startedAt = Date.now();

    try {
      const rows = await DriverLocation.aggregate<GeoNearRow>(pipeline).exec();
      const elapsedMs = Date.now() - startedAt;

      logger.debug(
        `[DriverLocationService] Proximity search matched ${rows.length} driver(s) ` +
          `within ${radiusMeters}m in ${elapsedMs}ms`,
      );

      return {
        drivers: rows.map((row) => this.toNearbyDriver(row)),
        count: rows.length,
        radiusMeters,
        center: { lat, lng },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[DriverLocationService] Proximity search failed: ${message}`);
      throw new AppError('Unable to search for nearby drivers.', StatusCodes.INTERNAL_SERVER_ERROR);
    }
  }

  /**
   * Record a driver's current position, creating the record on first report.
   *
   * The write is a single upsert, so a burst of pings from one device cannot
   * create duplicate rows for that driver.
   *
   * @throws {AppError} 400 — invalid driver id or coordinates.
   */
  public async upsertDriverLocation(input: UpsertDriverLocationInput): Promise<IDriverLocation> {
    const driverId = this.assertValidObjectId(input.driverId, 'driverId');
    const { lat, lng } = this.assertValidCoordinates(input.lat, input.lng);
    const recordedAt = input.recordedAt ?? new Date();

    const update: Record<string, unknown> = {
      location: { type: 'Point', coordinates: [lng, lat] },
      recordedAt,
      expiresAt: new Date(recordedAt.getTime() + env.DRIVER_LOCATION_STALE_AFTER_SECONDS * 1000),
    };

    if (input.isAvailable !== undefined) update.isAvailable = input.isAvailable;
    if (input.status !== undefined) update.status = input.status;
    if (input.heading !== undefined) update.heading = input.heading;
    if (input.speed !== undefined) update.speed = input.speed;
    if (input.accuracy !== undefined) update.accuracy = input.accuracy;
    if (input.currentDeliveryId !== undefined) {
      update.currentDeliveryId = input.currentDeliveryId
        ? this.assertValidObjectId(input.currentDeliveryId, 'currentDeliveryId')
        : null;
    }

    try {
      const document = await DriverLocation.findOneAndUpdate(
        { driverId },
        { $set: update, $setOnInsert: { driverId } },
        { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
      ).exec();

      return document;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        `[DriverLocationService] Failed to persist location for driver ${input.driverId}: ${message}`,
      );
      throw new AppError(
        'Unable to record the driver location.',
        StatusCodes.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Fetch one driver's current position.
   *
   * @throws {AppError} 400 — malformed driver id.
   * @throws {AppError} 404 — no current position on record for that driver.
   */
  public async getDriverLocation(driverIdRaw: string): Promise<IDriverLocation> {
    const driverId = this.assertValidObjectId(driverIdRaw, 'driverId');
    const document = await DriverLocation.findOne({ driverId }).exec();

    if (!document) {
      throw new AppError(
        `No current location on record for driver ${driverIdRaw}.`,
        StatusCodes.NOT_FOUND,
      );
    }
    return document;
  }

  /**
   * Run the proximity query with `explain()` and report which index the
   * planner chose plus how much work it did.
   *
   * This is the profiling hook the issue calls for: it makes index regressions
   * observable, rather than something that only shows up as latency in
   * production. It reads real plans from the real collection.
   *
   * @returns The planner summary and the raw `explain` output.
   */
  public async explainProximityQuery(query: NearbyDriversQuery): Promise<{
    indexUsed: string;
    executionTimeMillis: number;
    totalDocsExamined: number;
    nReturned: number;
    raw: unknown;
  }> {
    const { lat, lng } = this.assertValidCoordinates(query.lat, query.lng);
    const radiusMeters = this.resolveRadius(query.radiusMeters);
    const availableOnly = query.availableOnly ?? true;

    const filter: Record<string, unknown> = {};
    if (availableOnly) filter.isAvailable = true;
    if (query.status) filter.status = query.status;

    const pipeline: PipelineStage[] = [
      {
        $geoNear: {
          near: { type: 'Point', coordinates: [lng, lat] },
          distanceField: 'distanceMeters',
          maxDistance: radiusMeters,
          spherical: true,
          query: filter,
          key: 'location',
        },
      },
      { $limit: this.resolveLimit(query.limit) },
    ];

    const raw = (await DriverLocation.aggregate(pipeline)
      .option({ explain: true })
      .exec()) as unknown;

    const summary = this.summariseExplain(raw);

    logger.info(
      `[DriverLocationService] Proximity explain — index=${summary.indexUsed} ` +
        `docsExamined=${summary.totalDocsExamined} returned=${summary.nReturned} ` +
        `timeMs=${summary.executionTimeMillis}`,
    );

    return { ...summary, raw };
  }

  /**
   * Ensure every index declared on the schema exists in MongoDB.
   *
   * Mongoose builds indexes in the background on first use, which means the
   * very first proximity query after a deploy can run without them. Calling
   * this at startup makes index creation explicit and surfaces failures.
   *
   * @returns The names of the indexes present after synchronisation.
   */
  public async ensureIndexes(): Promise<string[]> {
    await DriverLocation.createIndexes();
    const indexes = (await DriverLocation.collection.indexes()) as Array<{ name?: string }>;
    const names = indexes.map((index) => index.name ?? 'unnamed');

    logger.info(`[DriverLocationService] DriverLocation indexes ready: ${names.join(', ')}`);
    return names;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /** Map a raw `$geoNear` row onto the API shape, rounding the distance. */
  private toNearbyDriver(row: GeoNearRow): NearbyDriver {
    const [lng, lat] = row.location.coordinates;

    return {
      driverId: row.driverId.toString(),
      distanceMeters: Math.round(row.distanceMeters),
      lat,
      lng,
      isAvailable: row.isAvailable,
      status: row.status,
      heading: row.heading,
      speed: row.speed,
      accuracy: row.accuracy,
      currentDeliveryId: row.currentDeliveryId ? row.currentDeliveryId.toString() : undefined,
      recordedAt: row.recordedAt,
    };
  }

  /** Validate a latitude/longitude pair. */
  private assertValidCoordinates(lat: number, lng: number): { lat: number; lng: number } {
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      throw new AppError('lat must be a number between -90 and 90.', StatusCodes.BAD_REQUEST);
    }
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
      throw new AppError('lng must be a number between -180 and 180.', StatusCodes.BAD_REQUEST);
    }
    return { lat, lng };
  }

  /** Clamp the radius to the configured maximum, defaulting when absent. */
  private resolveRadius(radiusMeters?: number): number {
    if (radiusMeters === undefined) return env.DRIVER_PROXIMITY_DEFAULT_RADIUS_M;

    if (!Number.isFinite(radiusMeters) || radiusMeters <= 0) {
      throw new AppError('radiusMeters must be a positive number.', StatusCodes.BAD_REQUEST);
    }

    if (radiusMeters > env.DRIVER_PROXIMITY_MAX_RADIUS_M) {
      throw new AppError(
        `radiusMeters cannot exceed ${env.DRIVER_PROXIMITY_MAX_RADIUS_M}.`,
        StatusCodes.BAD_REQUEST,
      );
    }
    return radiusMeters;
  }

  /** Clamp the result limit to the configured maximum, defaulting when absent. */
  private resolveLimit(limit?: number): number {
    if (limit === undefined) return env.DRIVER_PROXIMITY_MAX_RESULTS;

    if (!Number.isInteger(limit) || limit <= 0) {
      throw new AppError('limit must be a positive integer.', StatusCodes.BAD_REQUEST);
    }
    return Math.min(limit, env.DRIVER_PROXIMITY_MAX_RESULTS);
  }

  /** Validate and cast a Mongo ObjectId supplied as a string. */
  private assertValidObjectId(value: string, field: string): Types.ObjectId {
    if (!Types.ObjectId.isValid(value)) {
      throw new AppError(`${field} must be a valid ObjectId.`, StatusCodes.BAD_REQUEST);
    }
    return new Types.ObjectId(value);
  }

  /**
   * Pull the interesting numbers out of an `explain` document.
   *
   * The shape differs between standalone servers, sharded clusters and server
   * versions, so every field is probed defensively and falls back to a stable
   * default rather than throwing.
   */
  private summariseExplain(raw: unknown): {
    indexUsed: string;
    executionTimeMillis: number;
    totalDocsExamined: number;
    nReturned: number;
  } {
    const root = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown> | undefined;

    const stages = (root?.stages as Array<Record<string, unknown>> | undefined) ?? [];
    const geoNearStage = stages.find((stage) => '$geoNearCursor' in stage || '$cursor' in stage);

    const cursor = (geoNearStage?.['$geoNearCursor'] ?? geoNearStage?.['$cursor'] ?? root) as
      | Record<string, unknown>
      | undefined;

    const queryPlanner = cursor?.queryPlanner as Record<string, unknown> | undefined;
    const executionStats = (cursor?.executionStats ?? root?.executionStats) as
      | Record<string, unknown>
      | undefined;

    const winningPlan = queryPlanner?.winningPlan as Record<string, unknown> | undefined;

    return {
      indexUsed: this.findIndexName(winningPlan) ?? 'unknown',
      executionTimeMillis: Number(executionStats?.executionTimeMillis ?? 0),
      totalDocsExamined: Number(executionStats?.totalDocsExamined ?? 0),
      nReturned: Number(executionStats?.nReturned ?? 0),
    };
  }

  /** Walk a winning plan tree looking for the first `indexName`. */
  private findIndexName(plan: Record<string, unknown> | undefined): string | undefined {
    if (!plan || typeof plan !== 'object') return undefined;

    if (typeof plan.indexName === 'string') return plan.indexName;

    for (const value of Object.values(plan)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          const found = this.findIndexName(item as Record<string, unknown>);
          if (found) return found;
        }
      } else if (value && typeof value === 'object') {
        const found = this.findIndexName(value as Record<string, unknown>);
        if (found) return found;
      }
    }
    return undefined;
  }
}

/** Singleton used by the controller layer. */
export const driverLocationService = new DriverLocationService();
