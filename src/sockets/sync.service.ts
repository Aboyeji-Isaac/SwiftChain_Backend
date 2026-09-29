import { Types } from 'mongoose';
import env from '../config/env';
import logger from '../config/logger';
import { LocationUpdate, ILocationUpdate } from '../models/LocationUpdate';
import { toUTC, nowUTC } from '../utils/dateUtils';
import {
  LocationSyncPayload,
  OfflineLocationPoint,
  LocationSyncAck,
  SyncItemResult,
} from './socket.types';
import env from '../config/env';

/**
 * Maximum number of location points accepted in a single sync batch.
 * Protects against abusive or runaway clients.
 * Overridable via SYNC_BATCH_SIZE_LIMIT env var.
 */
const BATCH_SIZE_LIMIT = env.SYNC_BATCH_SIZE_LIMIT;

/**
 * SyncService handles the business logic for offline catch-up sync:
 *   - Validates each incoming location point.
 *   - Detects and skips duplicate entries (same driverId + capturedAt).
 *   - Persists valid points to MongoDB in a single bulkWrite for efficiency.
 *   - Returns a per-item acknowledgement so the client can reconcile.
 */
export class SyncService {
  /**
   * Process a batch of offline location updates from a driver.
   *
   * Flow:
   *   1. Enforce batch-size limit.
   *   2. Validate each point individually.
   *   3. Deduplicate against the database (and within the batch itself).
   *   4. Bulk-insert valid, unique points.
   *   5. Build and return a `LocationSyncAck`.
   *
   * @param driverId - MongoDB ObjectId string of the authenticated driver.
   * @param payload  - The sync payload containing the buffered updates array.
   * @returns          A full acknowledgement with per-item results.
   */
  public async processBatch(
    driverId: string,
    payload: LocationSyncPayload,
  ): Promise<LocationSyncAck> {
    const processedAt = nowUTC().toISOString();

    // ── 1. Validate driverId ─────────────────────────────────────────────────
    if (!Types.ObjectId.isValid(driverId)) {
      logger.warn(`[Sync] Invalid driverId="${driverId}" — rejecting batch`);
      throw new Error(`Invalid driverId: ${driverId}`);
    }

    const driverObjectId = new Types.ObjectId(driverId);

    // ── 2. Enforce batch size ────────────────────────────────────────────────
    const raw = payload.updates ?? [];
    const updates = raw.slice(0, BATCH_SIZE_LIMIT);

    if (raw.length > BATCH_SIZE_LIMIT) {
      logger.warn(
        `[Sync] driverId=${driverId} sent ${raw.length} updates — ` +
          `truncated to BATCH_SIZE_LIMIT=${BATCH_SIZE_LIMIT}`,
      );
    }

    logger.info(`[Sync] Processing batch — driverId=${driverId} count=${updates.length}`);

    // ── 3. Per-item validation ────────────────────────────────────────────────
    const results: SyncItemResult[] = [];
    const validPoints: OfflineLocationPoint[] = [];

    for (const point of updates) {
      const validationError = this.validatePoint(point);
      if (validationError) {
        results.push({
          capturedAt: point.capturedAt ?? 0,
          status: 'invalid',
          reason: validationError,
        });
        continue;
      }
      validPoints.push(point);
    }

    if (validPoints.length === 0) {
      return this.buildAck(processedAt, updates.length, results);
    }

    // ── 4. Fetch existing capturedAt values for this driver to detect dupes ──
    const capturedAtDates = validPoints.map((p) => toUTC(p.capturedAt));

    const existingDocs = await LocationUpdate.find(
      {
        driverId: driverObjectId,
        capturedAt: { $in: capturedAtDates },
      },
      { capturedAt: 1 },
    ).lean<Pick<ILocationUpdate, 'capturedAt'>[]>();

    const existingSet = new Set<number>(existingDocs.map((d) => toUTC(d.capturedAt).getTime()));

    // ── 5. Build insertable documents, deduplicating within batch ─────────────
    const seenInBatch = new Set<number>();
    const toInsert: Partial<ILocationUpdate>[] = [];

    for (const point of validPoints) {
      const ts = point.capturedAt;

      if (existingSet.has(ts) || seenInBatch.has(ts)) {
        results.push({ capturedAt: ts, status: 'duplicate' });
        continue;
      }

      seenInBatch.add(ts);

      toInsert.push({
        driverId: driverObjectId,
        deliveryId: point.deliveryId ? new Types.ObjectId(point.deliveryId) : undefined,
        coordinates: { lat: point.lat, lng: point.lng },
        capturedAt: toUTC(ts),
        isOfflineSync: true,
        status: 'pending',
      });
    }

    // ── 6. Bulk insert ────────────────────────────────────────────────────────
    if (toInsert.length > 0) {
      try {
        await LocationUpdate.insertMany(toInsert, { ordered: false });

        for (const doc of toInsert) {
          results.push({
            capturedAt: (doc.capturedAt as Date).getTime(),
            status: 'saved',
          });
        }

        logger.info(`[Sync] Persisted ${toInsert.length} location updates — driverId=${driverId}`);
      } catch (err) {
        // insertMany with ordered:false may partially succeed.
        // Mark all pending-insert items as failed.
        const errMsg = err instanceof Error ? err.message : 'Unknown error';
        logger.error(`[Sync] bulkInsert failed — driverId=${driverId}: ${errMsg}`);

        for (const doc of toInsert) {
          results.push({
            capturedAt: (doc.capturedAt as Date).getTime(),
            status: 'error',
            reason: errMsg,
          });
        }
      }
    }

    return this.buildAck(processedAt, updates.length, results);
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  /**
   * Validate a single location point.
   *
   * @param point - The point to validate.
   * @returns       An error string if invalid, or null if valid.
   */
  private validatePoint(point: OfflineLocationPoint): string | null {
    if (
      typeof point.capturedAt !== 'number' ||
      !Number.isFinite(point.capturedAt) ||
      point.capturedAt <= 0
    ) {
      return 'capturedAt must be a positive finite number (ms epoch)';
    }

    if (typeof point.lat !== 'number' || !Number.isFinite(point.lat)) {
      return 'lat must be a finite number';
    }
    if (point.lat < -90 || point.lat > 90) {
      return `lat out of range: ${point.lat}`;
    }

    if (typeof point.lng !== 'number' || !Number.isFinite(point.lng)) {
      return 'lng must be a finite number';
    }
    if (point.lng < -180 || point.lng > 180) {
      return `lng out of range: ${point.lng}`;
    }

    if (point.deliveryId !== undefined && !Types.ObjectId.isValid(point.deliveryId)) {
      return `deliveryId is not a valid ObjectId: ${point.deliveryId}`;
    }

    return null;
  }

  /**
   * Assemble the final `LocationSyncAck` from the accumulated per-item results.
   */
  private buildAck(
    processedAt: string,
    received: number,
    results: SyncItemResult[],
  ): LocationSyncAck {
    const saved = results.filter((r) => r.status === 'saved').length;
    const duplicates = results.filter((r) => r.status === 'duplicate').length;
    const failed = results.filter((r) => r.status === 'error' || r.status === 'invalid').length;

    return {
      processedAt,
      received,
      saved,
      duplicates,
      failed,
      results,
    };
  }
}

/** Singleton instance shared across the sockets layer. */
export const syncService = new SyncService();
