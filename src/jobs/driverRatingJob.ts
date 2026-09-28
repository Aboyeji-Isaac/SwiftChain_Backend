import cron, { ScheduledTask } from 'node-cron';
import logger from '../config/logger';
import env from '../config/env';
import { driverRatingService } from '../services/driverRatingService';

/**
 * Cron expression the driver-rating sweep runs on. Defaults to hourly.
 * Override with the `DRIVER_RATING_CRON` environment variable.
 */
const DRIVER_RATING_CRON = env.DRIVER_RATING_CRON;

let scheduledTask: ScheduledTask | null = null;
let isRunning = false;

/**
 * Runs one rating sweep over every driver with delivery history.
 *
 * Exported separately from the scheduler so it can be invoked directly
 * (e.g. from tests or an on-demand admin trigger) without waiting for the
 * next cron tick.
 */
export const runDriverRatingSweep = async (): Promise<void> => {
  if (isRunning) {
    logger.warn('[DriverRatingJob] Previous sweep still in progress — skipping this tick.');
    return;
  }

  isRunning = true;
  try {
    const result = await driverRatingService.recalculateAllDriverRatings();
    logger.debug(
      `[DriverRatingJob] Sweep complete — processed=${result.processed} ` +
        `updated=${result.updated} suspended=${result.suspended} lifted=${result.lifted}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error(`[DriverRatingJob] Sweep failed: ${message}`);
  } finally {
    isRunning = false;
  }
};

/**
 * Starts the recurring background job that keeps driver ratings and penalty
 * state current. Safe to call once at process startup.
 */
export const startDriverRatingJob = (): ScheduledTask => {
  if (scheduledTask) {
    return scheduledTask;
  }

  if (!cron.validate(DRIVER_RATING_CRON)) {
    throw new Error(`Invalid DRIVER_RATING_CRON expression: "${DRIVER_RATING_CRON}"`);
  }

  scheduledTask = cron.schedule(DRIVER_RATING_CRON, () => {
    void runDriverRatingSweep();
  });

  logger.info(`[DriverRatingJob] Job scheduled with cron expression "${DRIVER_RATING_CRON}"`);

  return scheduledTask;
};

/**
 * Stops the recurring job, if running. Used during graceful shutdown and in
 * tests to avoid leaking timers.
 */
export const stopDriverRatingJob = (): void => {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }
};
