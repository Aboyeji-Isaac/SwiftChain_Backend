/**
 * driverLocationController.ts
 *
 * HTTP layer for driver positions and proximity search.
 *
 * Controllers parse and validate the transport-level shape of a request —
 * query strings arrive as strings and must become numbers — then delegate all
 * business logic to `DriverLocationService`. No database access happens here.
 */

import { Request, Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import {
  driverLocationService,
  DriverLocationService,
  NearbyDriversQuery,
} from '../services/driverLocationService';
import { DriverAvailabilityStatus } from '../models/DriverLocation';
import { sendSuccess } from '../utils/responseWrapper';
import AppError from '../utils/AppError';
import type { IUser } from '../interfaces/IUser';

/** Availability values a client may filter on. */
const VALID_STATUSES: readonly DriverAvailabilityStatus[] = ['online', 'offline', 'on_delivery'];

export class DriverLocationController {
  private readonly service: DriverLocationService;

  constructor(service: DriverLocationService = driverLocationService) {
    this.service = service;
  }

  /**
   * GET /api/v1/drivers/nearby
   *
   * Query parameters:
   *   `lat`, `lng`        — required search centre.
   *   `radiusMeters`      — optional, clamped to the configured maximum.
   *   `limit`             — optional result cap.
   *   `availableOnly`     — optional boolean, defaults to true.
   *   `status`            — optional availability filter.
   */
  public async getNearbyDrivers(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const query: NearbyDriversQuery = {
        lat: this.requireNumber(req.query.lat, 'lat'),
        lng: this.requireNumber(req.query.lng, 'lng'),
        radiusMeters: this.optionalNumber(req.query.radiusMeters, 'radiusMeters'),
        limit: this.optionalNumber(req.query.limit, 'limit'),
        availableOnly: this.optionalBoolean(req.query.availableOnly, 'availableOnly'),
        status: this.optionalStatus(req.query.status),
      };

      const result = await this.service.findNearbyDrivers(query);

      sendSuccess(
        res,
        result,
        `Found ${result.count} driver(s) within ${result.radiusMeters}m`,
        StatusCodes.OK,
      );
    } catch (error) {
      next(error);
    }
  }

  /**
   * PUT /api/v1/drivers/me/location
   *
   * Records the authenticated driver's current position.
   */
  public async updateMyLocation(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const user = (req as Request & { user?: IUser }).user;
      if (!user) {
        throw new AppError('Authentication required.', StatusCodes.UNAUTHORIZED);
      }

      const body = req.body as Record<string, unknown>;

      const document = await this.service.upsertDriverLocation({
        driverId: String(user._id),
        lat: this.requireNumber(body.lat, 'lat'),
        lng: this.requireNumber(body.lng, 'lng'),
        isAvailable: this.optionalBoolean(body.isAvailable, 'isAvailable'),
        status: this.optionalStatus(body.status),
        heading: this.optionalNumber(body.heading, 'heading'),
        speed: this.optionalNumber(body.speed, 'speed'),
        accuracy: this.optionalNumber(body.accuracy, 'accuracy'),
        currentDeliveryId:
          body.currentDeliveryId === undefined
            ? undefined
            : body.currentDeliveryId === null
              ? null
              : String(body.currentDeliveryId),
        recordedAt: this.optionalDate(body.recordedAt),
      });

      sendSuccess(
        res,
        {
          driverId: document.driverId.toString(),
          ...document.toLatLng(),
          isAvailable: document.isAvailable,
          status: document.status,
          recordedAt: document.recordedAt,
        },
        'Driver location recorded successfully',
        StatusCodes.OK,
      );
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/v1/drivers/:driverId/location
   *
   * Returns a single driver's most recent position.
   */
  public async getDriverLocation(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const document = await this.service.getDriverLocation(req.params.driverId);

      sendSuccess(
        res,
        {
          driverId: document.driverId.toString(),
          ...document.toLatLng(),
          isAvailable: document.isAvailable,
          status: document.status,
          heading: document.heading,
          speed: document.speed,
          accuracy: document.accuracy,
          recordedAt: document.recordedAt,
        },
        'Driver location retrieved successfully',
        StatusCodes.OK,
      );
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/v1/drivers/nearby/explain
   *
   * Runs the proximity query under `explain()` and reports which index the
   * planner used and how many documents it examined. Admin-only: it exposes
   * database internals and is meant for profiling index health.
   */
  public async explainNearbyQuery(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const summary = await this.service.explainProximityQuery({
        lat: this.requireNumber(req.query.lat, 'lat'),
        lng: this.requireNumber(req.query.lng, 'lng'),
        radiusMeters: this.optionalNumber(req.query.radiusMeters, 'radiusMeters'),
        limit: this.optionalNumber(req.query.limit, 'limit'),
        availableOnly: this.optionalBoolean(req.query.availableOnly, 'availableOnly'),
        status: this.optionalStatus(req.query.status),
      });

      sendSuccess(res, summary, 'Proximity query plan retrieved successfully', StatusCodes.OK);
    } catch (error) {
      next(error);
    }
  }

  // ── Parameter coercion helpers ─────────────────────────────────────────────

  /** Parse a required numeric parameter. */
  private requireNumber(value: unknown, field: string): number {
    if (value === undefined || value === null || value === '') {
      throw new AppError(`${field} is required.`, StatusCodes.BAD_REQUEST);
    }

    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      throw new AppError(`${field} must be a valid number.`, StatusCodes.BAD_REQUEST);
    }
    return parsed;
  }

  /** Parse an optional numeric parameter, preserving `undefined`. */
  private optionalNumber(value: unknown, field: string): number | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    return this.requireNumber(value, field);
  }

  /** Parse an optional boolean, accepting the string forms a query string yields. */
  private optionalBoolean(value: unknown, field: string): boolean | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value === 'boolean') return value;

    const normalised = String(value).toLowerCase();
    if (normalised === 'true' || normalised === '1') return true;
    if (normalised === 'false' || normalised === '0') return false;

    throw new AppError(`${field} must be a boolean.`, StatusCodes.BAD_REQUEST);
  }

  /** Parse an optional availability filter. */
  private optionalStatus(value: unknown): DriverAvailabilityStatus | undefined {
    if (value === undefined || value === null || value === '') return undefined;

    const candidate = String(value) as DriverAvailabilityStatus;
    if (!VALID_STATUSES.includes(candidate)) {
      throw new AppError(
        `status must be one of: ${VALID_STATUSES.join(', ')}.`,
        StatusCodes.BAD_REQUEST,
      );
    }
    return candidate;
  }

  /** Parse an optional ISO-8601 timestamp. */
  private optionalDate(value: unknown): Date | undefined {
    if (value === undefined || value === null || value === '') return undefined;

    const parsed = new Date(String(value));
    if (Number.isNaN(parsed.getTime())) {
      throw new AppError('recordedAt must be a valid ISO-8601 date.', StatusCodes.BAD_REQUEST);
    }
    return parsed;
  }
}

/** Singleton used by the route layer. */
export const driverLocationController = new DriverLocationController();
