import cron, { ScheduledTask } from 'node-cron';
import logger from '../config/logger';
import { assignmentService } from '../services/assignmentService';
import env from '../config/env';

/**
 * Cron expression the auto-assignment sweep runs on. Defaults to every
 * minute. Override with the `AUTO_ASSIGNMENT_CRON` environment variable.
 */
const AUTO_ASSIGNMENT_CRON = env.AUTO_ASSIGNMENT_CRON;

let scheduledTask: ScheduledTask | null = null;
let isRunning = false;

/**
 * Runs a single sweep, attempting to assign the nearest available driver to
 * every funded delivery that has none yet.
 *
 * Exported separately from the scheduler so it can be invoked directly
 * (e.g. from tests, or an on-demand admin trigger) without waiting for the
 * next tick of the cron schedule.
 */
export const runAutoAssignmentSweep = async (): Promise<void> => {
  if (isRunning) {
    logger.warn('[AutoAssignmentJob] Previous sweep still in progress — skipping this tick.');
    return;
  }

  isRunning = true;
  try {
    const result = await assignmentService.autoAssignPendingDeliveries();
    if (result.attempted > 0) {
      logger.info(
        `[AutoAssignmentJob] Sweep complete — assigned ${result.assigned}/${result.attempted} delivery(ies).`,
      );
    } else {
      logger.debug('[AutoAssignmentJob] Sweep complete — no unassigned funded deliveries.');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error(`[AutoAssignmentJob] Sweep failed: ${message}`);
  } finally {
    isRunning = false;
  }
};

/**
 * Starts the recurring background job that auto-assigns nearby drivers to
 * unassigned funded deliveries. Safe to call once at process startup.
 */
export const startAutoAssignmentJob = (): ScheduledTask => {
  if (scheduledTask) {
    return scheduledTask;
  }

  if (!cron.validate(AUTO_ASSIGNMENT_CRON)) {
    throw new Error(`Invalid AUTO_ASSIGNMENT_CRON expression: "${AUTO_ASSIGNMENT_CRON}"`);
  }

  scheduledTask = cron.schedule(AUTO_ASSIGNMENT_CRON, () => {
    void runAutoAssignmentSweep();
  });

  logger.info(`[AutoAssignmentJob] Job scheduled with cron expression "${AUTO_ASSIGNMENT_CRON}"`);

  return scheduledTask;
};

/**
 * Stops the recurring job, if running. Used during graceful shutdown and in
 * tests to avoid leaking timers.
 */
export const stopAutoAssignmentJob = (): void => {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }
};
