import cron, { ScheduledTask } from 'node-cron';
import env from '../config/env';
import logger from '../config/logger';
import { escrowService } from '../services/escrow.service';
import env from '../config/env';

/**
 * Cron expression the escrow monitor runs on. Defaults to every 5 minutes.
 * Override with the `ESCROW_MONITOR_CRON` environment variable.
 */
const ESCROW_MONITOR_CRON = env.ESCROW_MONITOR_CRON;

let scheduledTask: ScheduledTask | null = null;
let isRunning = false;

/**
 * Runs a single escrow-expiry scan.
 *
 * Exported separately from the scheduler so it can be invoked directly
 * (e.g. from tests, or an on-demand admin trigger) without waiting for the
 * next tick of the cron schedule.
 */
export const runEscrowExpiryScan = async (): Promise<void> => {
  if (isRunning) {
    logger.warn('[EscrowMonitor] Previous scan still in progress — skipping this tick.');
    return;
  }

  isRunning = true;
  try {
    const result = await escrowService.scanForExpiredEscrows();
    if (result.flaggedCount > 0) {
      logger.info(
        `[EscrowMonitor] Scan complete — flagged ${result.flaggedCount} expired escrow(s).`,
      );
    } else {
      logger.debug('[EscrowMonitor] Scan complete — no expired escrows found.');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error(`[EscrowMonitor] Scan failed: ${message}`);
  } finally {
    isRunning = false;
  }
};

/**
 * Starts the recurring background job that monitors escrow locks for
 * expiry. Safe to call once at process startup.
 */
export const startEscrowMonitorJob = (): ScheduledTask => {
  if (scheduledTask) {
    return scheduledTask;
  }

  if (!cron.validate(ESCROW_MONITOR_CRON)) {
    throw new Error(`Invalid ESCROW_MONITOR_CRON expression: "${ESCROW_MONITOR_CRON}"`);
  }

  scheduledTask = cron.schedule(ESCROW_MONITOR_CRON, () => {
    void runEscrowExpiryScan();
  });

  logger.info(`[EscrowMonitor] Job scheduled with cron expression "${ESCROW_MONITOR_CRON}"`);

  return scheduledTask;
};

/**
 * Stops the recurring job, if running. Used during graceful shutdown and in
 * tests to avoid leaking timers.
 */
export const stopEscrowMonitorJob = (): void => {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }
};
