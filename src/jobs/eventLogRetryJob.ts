import cron, { ScheduledTask } from 'node-cron';
import logger from '../config/logger';
import { eventLogRetryService } from '../services/eventLogRetryService';
import env from '../config/env';

/**
 * Cron expression the EventLog retry sweep runs on. Defaults to every minute.
 * Override with the `EVENTLOG_RETRY_CRON` environment variable.
 */
const EVENTLOG_RETRY_CRON = env.EVENTLOG_RETRY_CRON;

let scheduledTask: ScheduledTask | null = null;
let isRunning = false;

/**
 * Runs a single sweep over failed EventLog entries whose backoff window has
 * elapsed, replaying each through the event poller's dispatch path.
 *
 * Exported separately from the scheduler so it can be invoked directly
 * (e.g. from tests) without waiting for the next tick of the cron schedule.
 */
export const runEventLogRetrySweep = async (): Promise<void> => {
  if (isRunning) {
    logger.warn('[EventLogRetryJob] Previous sweep still in progress — skipping this tick.');
    return;
  }

  isRunning = true;
  try {
    const result = await eventLogRetryService.retryDue();
    if (result.attempted > 0) {
      logger.info(
        `[EventLogRetryJob] Sweep complete — attempted=${result.attempted} ` +
          `processed=${result.processed} rescheduled=${result.rescheduled} ` +
          `deadLettered=${result.deadLettered}`,
      );
    } else {
      logger.debug('[EventLogRetryJob] Sweep complete — no due entries.');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error(`[EventLogRetryJob] Sweep failed: ${message}`);
  } finally {
    isRunning = false;
  }
};

/**
 * Starts the recurring background job that retries failed indexer events.
 * Safe to call once at process startup.
 */
export const startEventLogRetryJob = (): ScheduledTask => {
  if (scheduledTask) {
    return scheduledTask;
  }

  if (!cron.validate(EVENTLOG_RETRY_CRON)) {
    throw new Error(`Invalid EVENTLOG_RETRY_CRON expression: "${EVENTLOG_RETRY_CRON}"`);
  }

  scheduledTask = cron.schedule(EVENTLOG_RETRY_CRON, () => {
    void runEventLogRetrySweep();
  });

  logger.info(`[EventLogRetryJob] Job scheduled with cron expression "${EVENTLOG_RETRY_CRON}"`);

  return scheduledTask;
};

/**
 * Stops the recurring job, if running. Used during graceful shutdown and in
 * tests to avoid leaking timers.
 */
export const stopEventLogRetryJob = (): void => {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }
};
