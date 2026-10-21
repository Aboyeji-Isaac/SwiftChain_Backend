import cron, { ScheduledTask } from 'node-cron';
import env from '../config/env';
import logger from '../config/logger';
import { escrowService } from '../services/escrow.service';

/**
 * Cron expression the escrow monitor runs on. Defaults to every 5 minutes.
 * Override with the `ESCROW_MONITOR_CRON` environment variable.
 */
const ESCROW_MONITOR_CRON = env.ESCROW_MONITOR_CRON;

let scheduledTask: ScheduledTask | null = null;
let isRunning = false;

/** One escrow-expiry scan (lock TTL elapsed -> flag as expired). */
const runExpiryScanOnce = async (): Promise<void> => {
  const result = await escrowService.scanForExpiredEscrows();
  if (result.flaggedCount > 0) {
    logger.info(
      `[EscrowMonitor] Scan complete — flagged ${result.flaggedCount} expired escrow(s).`,
    );
  } else {
    logger.debug('[EscrowMonitor] Scan complete — no expired escrows found.');
  }
};

/** One escrow funding-window lapse scan (unfunded past fundBy -> cancelled). */
const runFundingWindowScanOnce = async (): Promise<void> => {
  const result = await escrowService.scanLapsedFundingWindows();
  if (result.cancelledCount > 0) {
    logger.info(
      `[EscrowMonitor] Funding-window scan complete — cancelled ${result.cancelledCount} unfunded delivery(ies).`,
    );
  } else {
    logger.debug('[EscrowMonitor] Funding-window scan complete — no lapsed windows found.');
  }
};

/**
 * Run one scan under the re-entrancy guard: only one monitor pass may be in
 * flight at a time, and every failure is logged rather than thrown so a bad
 * tick can never crash the scheduler.
 */
const runGuarded = async (label: string, run: () => Promise<void>): Promise<void> => {
  if (isRunning) {
    logger.warn('[EscrowMonitor] Previous scan still in progress — skipping this tick.');
    return;
  }

  isRunning = true;
  try {
    await run();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error(`[EscrowMonitor] ${label} failed: ${message}`);
  } finally {
    isRunning = false;
  }
};

/**
 * Runs a single escrow-expiry scan.
 *
 * Exported separately from the scheduler so it can be invoked directly
 * (e.g. from tests, or an on-demand admin trigger) without waiting for the
 * next tick of the cron schedule.
 */
export const runEscrowExpiryScan = async (): Promise<void> => {
  await runGuarded('Scan', runExpiryScanOnce);
};

/**
 * Runs a single escrow funding-window lapse scan (issue #247): cancels
 * deliveries whose `fundBy` deadline passed while their escrow was never
 * funded. Also exported for direct invocation from tests or admin triggers.
 */
export const runFundingWindowScan = async (): Promise<void> => {
  await runGuarded('Funding-window scan', runFundingWindowScanOnce);
};

/**
 * One full monitor tick: escrow lock expiry first, then funding-window
 * lapses. Both scans share the re-entrancy guard so ticks never overlap.
 */
export const runEscrowMonitorTick = async (): Promise<void> => {
  if (isRunning) {
    logger.warn('[EscrowMonitor] Previous scan still in progress — skipping this tick.');
    return;
  }

  isRunning = true;
  try {
    await runExpiryScanOnce();
    await runFundingWindowScanOnce();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error(`[EscrowMonitor] Scan failed: ${message}`);
  } finally {
    isRunning = false;
  }
};

/**
 * Starts the recurring background job that monitors escrow locks for expiry
 * and lapsed escrow funding windows. Safe to call once at process startup.
 */
export const startEscrowMonitorJob = (): ScheduledTask => {
  if (scheduledTask) {
    return scheduledTask;
  }

  if (!cron.validate(ESCROW_MONITOR_CRON)) {
    throw new Error(`Invalid ESCROW_MONITOR_CRON expression: "${ESCROW_MONITOR_CRON}"`);
  }

  scheduledTask = cron.schedule(ESCROW_MONITOR_CRON, () => {
    void runEscrowMonitorTick();
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
