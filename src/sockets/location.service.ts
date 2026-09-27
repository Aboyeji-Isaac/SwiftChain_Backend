import { Types } from 'mongoose';
import { Server as SocketIOServer } from 'socket.io';
import env from '../config/env';
import logger from '../config/logger';
import { LocationUpdate } from '../models/LocationUpdate';
import { redisClient } from '../config/redis';
import {
  DriverLocationUpdatePayload,
  LocationBroadcastPayload,
  LocationUpdateAck,
  ServerToClientEvents,
  ClientToServerEvents,
  InterServerEvents,
  SocketData,
} from './socket.types';

/**
 * Room name prefix for delivery-scoped broadcast rooms.
 * Clients subscribe to `delivery:<deliveryId>` to receive live updates.
 */
export const DELIVERY_ROOM_PREFIX = 'delivery:';

/**
 * TTL (in seconds) for deduplication keys in Redis.
 * Updates with the same deduplication key within this window are rejected.
 * Default: 60 seconds (can be overridden via LOCATION_DEDUP_TTL_SECONDS env var).
 */
const DEDUP_TTL_SECONDS = env.LOCATION_DEDUP_TTL_SECONDS;

/**
 * Maximum age (in milliseconds) for a location update to be considered valid.
 * Updates older than this are rejected as stale.
 * Default: 5 minutes (can be overridden via LOCATION_MAX_AGE_MS env var).
 */
const MAX_UPDATE_AGE_MS = env.LOCATION_MAX_AGE_MS;

/**
 * Maximum future timestamp tolerance (in milliseconds).
 * Updates with timestamps more than this far in the future are rejected.
 * Default: 30 seconds (can be overridden via LOCATION_MAX_FUTURE_MS env var).
 */
const MAX_FUTURE_TOLERANCE_MS = env.LOCATION_MAX_FUTURE_MS;

/**
 * Build the canonical Socket.IO room name for a delivery.
 */
export function deliveryRoom(deliveryId: string): string {
  return `${DELIVERY_ROOM_PREFIX}${deliveryId}`;
}

/**
 * Typed Socket.IO server alias used by the service.
 */
type TypedServer = SocketIOServer<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

/**
 * LocationService handles all business logic for real-time driver location
 * broadcasting with deduplication and race condition prevention.
 *
 * Responsibilities:
 *   - Validate incoming `driver_location_update` payloads.
 *   - Check for duplicate updates using Redis-based deduplication.
 *   - Validate timestamp to prevent stale or future-dated updates.
 *   - Persist the live update to MongoDB (reusing the `LocationUpdate` model,
 *     isOfflineSync = false).
 *   - Build the broadcast payload and emit `location:update` to the delivery
 *     room so all subscribed clients receive it.
 *   - Return a typed `LocationUpdateAck` to the controller.
 *
 * Race Condition Prevention:
 *   1. Redis-based deduplication with TTL prevents processing the same update twice
 *   2. Timestamp validation rejects stale updates from reconnection buffers
 *   3. Last-update tracking per driver-delivery pair prevents out-of-order updates
 */
export class LocationService {
  /**
   * Generate a deduplication key for a location update.
   * Uses driver ID, delivery ID, timestamp, and coordinates to create a unique identifier.
   *
   * @param driverId  - Driver's user ID
   * @param deliveryId - Delivery ID
   * @param capturedAt - Timestamp when location was captured
   * @param lat - Latitude (rounded to 6 decimal places for deduplication)
   * @param lng - Longitude (rounded to 6 decimal places for deduplication)
   * @returns Redis key for deduplication tracking
   */
  private generateDedupKey(
    driverId: string,
    deliveryId: string,
    capturedAt: number,
    lat: number,
    lng: number,
  ): string {
    // Round coordinates to 6 decimal places (~0.1 meter precision) for deduplication
    const roundedLat = Math.round(lat * 1000000) / 1000000;
    const roundedLng = Math.round(lng * 1000000) / 1000000;
    
    return `location:dedup:${driverId}:${deliveryId}:${capturedAt}:${roundedLat}:${roundedLng}`;
  }

  /**
   * Generate a key for tracking the last update timestamp for a driver-delivery pair.
   *
   * @param driverId - Driver's user ID
   * @param deliveryId - Delivery ID
   * @returns Redis key for last update tracking
   */
  private generateLastUpdateKey(driverId: string, deliveryId: string): string {
    return `location:last:${driverId}:${deliveryId}`;
  }

  /**
   * Check if an update is a duplicate using Redis.
   *
   * @param dedupKey - The deduplication key
   * @returns true if duplicate, false if unique
   */
  private async isDuplicate(dedupKey: string): Promise<boolean> {
    try {
      // Try to set the key with NX (only if not exists) and EX (expiry)
      const result = await redisClient.set(dedupKey, '1', 'EX', DEDUP_TTL_SECONDS, 'NX');
      
      // If result is null, the key already exists (duplicate)
      return result === null;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.warn(
        `[Location] Redis deduplication check failed, allowing update: ${message}`,
      );
      // On Redis errors, allow the update (fail open)
      return false;
    }
  }

  /**
   * Check if an update is older than the last processed update for this driver-delivery pair.
   *
   * @param driverId - Driver's user ID
   * @param deliveryId - Delivery ID
   * @param capturedAt - Timestamp of current update
   * @returns true if update is stale, false if it should be processed
   */
  private async isStaleUpdate(
    driverId: string,
    deliveryId: string,
    capturedAt: number,
  ): Promise<boolean> {
    try {
      const lastUpdateKey = this.generateLastUpdateKey(driverId, deliveryId);
      const lastTimestamp = await redisClient.get(lastUpdateKey);

      if (lastTimestamp) {
        const lastTime = parseInt(lastTimestamp, 10);
        if (capturedAt <= lastTime) {
          logger.debug(
            `[Location] Stale update detected — driverId=${driverId} ` +
              `deliveryId=${deliveryId} capturedAt=${capturedAt} lastTimestamp=${lastTime}`,
          );
          return true;
        }
      }

      // Update the last timestamp (with TTL to prevent indefinite growth)
      await redisClient.set(lastUpdateKey, capturedAt.toString(), 'EX', DEDUP_TTL_SECONDS * 2);
      return false;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.warn(
        `[Location] Redis stale check failed, allowing update: ${message}`,
      );
      // On Redis errors, allow the update (fail open)
      return false;
    }
  }

  /**
   * Validate timestamp to ensure it's not too old or too far in the future.
   *
   * @param capturedAt - Timestamp to validate
   * @returns Error message if invalid, null if valid
   */
  private validateTimestamp(capturedAt: number): string | null {
    const now = Date.now();
    const age = now - capturedAt;

    if (age > MAX_UPDATE_AGE_MS) {
      return `Update is too old: ${Math.round(age / 1000)}s ago (max: ${Math.round(MAX_UPDATE_AGE_MS / 1000)}s)`;
    }

    if (age < -MAX_FUTURE_TOLERANCE_MS) {
      return `Update timestamp is too far in the future: ${Math.round(-age / 1000)}s ahead`;
    }

    return null;
  }
  /**
   * Process a live driver location update with deduplication and race condition prevention:
   *   1. Validate the payload.
   *   2. Check timestamp validity (not too old, not too far in future).
   *   3. Check for duplicate updates (Redis-based deduplication).
   *   4. Check if update is stale (older than last processed update).
   *   5. Persist to MongoDB.
   *   6. Broadcast to the delivery room.
   *   7. Return an ack.
   *
   * @param io        - The Socket.IO server (needed to emit to rooms).
   * @param driverId  - Authenticated driver's userId from socket.data.
   * @param payload   - The raw `driver_location_update` payload.
   * @returns           A `LocationUpdateAck` (never throws — errors are caught).
   */
  public async processLiveUpdate(
    io: TypedServer,
    driverId: string,
    payload: DriverLocationUpdatePayload,
  ): Promise<LocationUpdateAck> {
    // ── 1. Validate payload ──────────────────────────────────────────────────
    const validationError = this.validatePayload(payload, driverId);
    if (validationError) {
      logger.warn(`[Location] Invalid payload from driverId=${driverId}: ${validationError}`);
      return { success: false, error: validationError };
    }

    const capturedAt = payload.capturedAt ?? Date.now();
    const receivedAt = new Date().toISOString();

    // ── 2. Validate timestamp ────────────────────────────────────────────────
    const timestampError = this.validateTimestamp(capturedAt);
    if (timestampError) {
      logger.warn(
        `[Location] Invalid timestamp from driverId=${driverId} ` +
          `deliveryId=${payload.deliveryId}: ${timestampError}`,
      );
      return { success: false, error: timestampError };
    }

    // ── 3. Check for duplicates (Redis-based) ────────────────────────────────
    const dedupKey = this.generateDedupKey(
      driverId,
      payload.deliveryId,
      capturedAt,
      payload.lat,
      payload.lng,
    );

    const isDuplicate = await this.isDuplicate(dedupKey);
    if (isDuplicate) {
      logger.info(
        `[Location] Duplicate update rejected — driverId=${driverId} ` +
          `deliveryId=${payload.deliveryId} capturedAt=${capturedAt}`,
      );
      return {
        success: false,
        error: 'Duplicate update (already processed within the last 60 seconds)',
        isDuplicate: true,
      };
    }

    // ── 4. Check if update is stale ──────────────────────────────────────────
    const isStale = await this.isStaleUpdate(driverId, payload.deliveryId, capturedAt);
    if (isStale) {
      logger.info(
        `[Location] Stale update rejected — driverId=${driverId} ` +
          `deliveryId=${payload.deliveryId} capturedAt=${capturedAt}`,
      );
      return {
        success: false,
        error: 'Stale update (older than last processed update)',
        isStale: true,
      };
    }

    // ── 5. Persist ───────────────────────────────────────────────────────────
    let locationId: string | undefined;

    try {
      const doc = await LocationUpdate.create({
        driverId: new Types.ObjectId(driverId),
        deliveryId: new Types.ObjectId(payload.deliveryId),
        coordinates: { lat: payload.lat, lng: payload.lng },
        capturedAt: new Date(capturedAt),
        isOfflineSync: false,
        status: 'pending',
      });

      locationId = doc._id.toString();

      logger.debug(
        `[Location] Persisted live update — driverId=${driverId} ` +
          `deliveryId=${payload.deliveryId} locationId=${locationId}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'DB write error';
      logger.error(
        `[Location] Failed to persist update — driverId=${driverId} ` +
          `deliveryId=${payload.deliveryId}: ${message}`,
      );
      return { success: false, error: message };
    }

    // ── 6. Broadcast to delivery room ────────────────────────────────────────
    const room = deliveryRoom(payload.deliveryId);

    const broadcastPayload: LocationBroadcastPayload = {
      deliveryId: payload.deliveryId,
      driverId,
      lat: payload.lat,
      lng: payload.lng,
      capturedAt,
      receivedAt,
    };

    io.to(room).emit('location:update', broadcastPayload);

    logger.info(
      `[Location] Broadcast location:update — deliveryId=${payload.deliveryId} ` +
        `driverId=${driverId} room="${room}" lat=${payload.lat} lng=${payload.lng}`,
    );

    // ── 7. Return ack ────────────────────────────────────────────────────────
    return { success: true, locationId };
  }

  /**
   * Validate a live location update payload.
   *
   * @returns An error string if invalid, or null if valid.
   */
  private validatePayload(payload: DriverLocationUpdatePayload, driverId: string): string | null {
    if (!Types.ObjectId.isValid(driverId)) {
      return `Invalid driverId: ${driverId}`;
    }

    if (!payload.deliveryId || !Types.ObjectId.isValid(payload.deliveryId)) {
      return `deliveryId is missing or not a valid ObjectId: ${payload.deliveryId}`;
    }

    if (typeof payload.lat !== 'number' || !Number.isFinite(payload.lat)) {
      return 'lat must be a finite number';
    }
    if (payload.lat < -90 || payload.lat > 90) {
      return `lat out of range: ${payload.lat}`;
    }

    if (typeof payload.lng !== 'number' || !Number.isFinite(payload.lng)) {
      return 'lng must be a finite number';
    }
    if (payload.lng < -180 || payload.lng > 180) {
      return `lng out of range: ${payload.lng}`;
    }

    if (
      payload.capturedAt !== undefined &&
      (typeof payload.capturedAt !== 'number' ||
        !Number.isFinite(payload.capturedAt) ||
        payload.capturedAt <= 0)
    ) {
      return 'capturedAt must be a positive finite number (ms epoch) if provided';
    }

    return null;
  }
}

/** Singleton instance shared across the sockets layer. */
export const locationService = new LocationService();
