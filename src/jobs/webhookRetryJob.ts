import cron, { ScheduledTask } from 'node-cron';
import logger from '../config/logger';
import { webhookService } from '../services/webhookService';
import env from '../config/env';

/**
 * Cron expression the webhook retry sweep runs on. Defaults to every minute.
 * Override with the `WEBHOOK_RETRY_CRON` environment variable.
 */
const WEBHOOK_RETRY_CRON = env.WEBHOOK_RETRY_CRON;

let scheduledTask: ScheduledTask | null = null;
let isRunning = false;

/**
 * Runs a single retry sweep over due, failed webhook delivery attempts.
 *
 * Exported separately from the scheduler so it can be invoked directly
 * (e.g. from tests, or an on-demand admin trigger) without waiting for the
 * next tick of the cron schedule.
 */
export const runWebhookRetrySweep = async (): Promise<void> => {
  if (isRunning) {
    logger.warn('[WebhookRetryJob] Previous sweep still in progress — skipping this tick.');
    return;
  }

  isRunning = true;
  try {
    const processed = await webhookService.retryDueAttempts();
    if (processed > 0) {
      logger.info(`[WebhookRetryJob] Sweep complete — retried ${processed} attempt(s).`);
    } else {
      logger.debug('[WebhookRetryJob] Sweep complete — no due attempts.');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error(`[WebhookRetryJob] Sweep failed: ${message}`);
  } finally {
    isRunning = false;
  }
};

/**
 * Starts the recurring background job that retries failed webhook
 * deliveries. Safe to call once at process startup.
 */
export const startWebhookRetryJob = (): ScheduledTask => {
  if (scheduledTask) {
    return scheduledTask;
  }

  if (!cron.validate(WEBHOOK_RETRY_CRON)) {
    throw new Error(`Invalid WEBHOOK_RETRY_CRON expression: "${WEBHOOK_RETRY_CRON}"`);
  }

  scheduledTask = cron.schedule(WEBHOOK_RETRY_CRON, () => {
    void runWebhookRetrySweep();
  });

  logger.info(`[WebhookRetryJob] Job scheduled with cron expression "${WEBHOOK_RETRY_CRON}"`);

  return scheduledTask;
};

/**
 * Stops the recurring job, if running. Used during graceful shutdown and in
 * tests to avoid leaking timers.
 */
export const stopWebhookRetryJob = (): void => {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }
};
