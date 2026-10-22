/**
 * One-shot data migration for issue #211.
 *
 * Before the status endpoint was unified onto the canonical `Delivery`
 * model, the legacy controller could write legacy vocabulary
 * (`picked_up`, `in_transit`, `delivered`) into the same collection,
 * producing documents no canonical flow understood.
 *
 * This script rewrites those documents to the closest canonical status:
 *
 *   legacy       -> canonical   (rationale)
 *   -------------+----------------------------------------------------------
 *   pending      -> pending     (same meaning)
 *   assigned     -> assigned    (same meaning)
 *   picked_up    -> in_progress (driver has the package; ramp is under way)
 *   in_transit   -> in_progress (mid-transit has no finer canonical state)
 *   delivered    -> completed   (terminal success)
 *
 * Run once per environment after deploying this change:
 *
 *   npm run migrate:delivery-statuses
 *
 * Idempotent: documents already carrying canonical statuses are left alone,
 * so re-running is safe. A status filter on the update keeps each rewrite
 * atomic and skips documents that a concurrent writer already fixed.
 */

import mongoose from 'mongoose';
import env from '../config/env';
import logger from '../config/logger';
import Delivery, { DeliveryStatus } from '../models/Delivery';

const LEGACY_TO_CANONICAL: Record<string, DeliveryStatus> = {
  pending: DeliveryStatus.PENDING,
  assigned: DeliveryStatus.ASSIGNED,
  picked_up: DeliveryStatus.IN_PROGRESS,
  in_transit: DeliveryStatus.IN_PROGRESS,
  delivered: DeliveryStatus.COMPLETED,
};

export const migrateLegacyDeliveryStatuses = async (): Promise<{
  scanned: number;
  migrated: number;
}> => {
  const legacyStatuses = Object.keys(LEGACY_TO_CANONICAL);
  const scanned = await Delivery.countDocuments({ status: { $in: legacyStatuses } });

  let migrated = 0;
  for (const [legacy, canonical] of Object.entries(LEGACY_TO_CANONICAL)) {
    const result = await Delivery.updateMany({ status: legacy }, { $set: { status: canonical } });
    migrated += result.modifiedCount ?? 0;
    if (result.modifiedCount) {
      logger.info(`[Migration] '${legacy}' -> '${canonical}': ${result.modifiedCount} document(s)`);
    }
  }

  logger.info(
    `[Migration] Legacy delivery statuses migrated — scanned=${scanned} migrated=${migrated}`,
  );
  return { scanned, migrated };
};

// Executed directly (`npm run migrate:delivery-statuses`): connect, migrate,
// disconnect. Imported as a module (tests): export only, no side effects.
if (require.main === module) {
  void (async () => {
    try {
      await mongoose.connect(env.MONGODB_URI);
      await migrateLegacyDeliveryStatuses();
      await mongoose.disconnect();
      process.exit(0);
    } catch (error) {
      logger.error(`[Migration] Failed: ${error instanceof Error ? error.message : String(error)}`);
      await mongoose.disconnect().catch(() => undefined);
      process.exit(1);
    }
  })();
}
