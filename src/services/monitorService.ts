import axios from 'axios';
import logger from '../config/logger';
import env from '../config/env';
import { stellarConfig } from '../config/stellar';
import { sorobanService } from '../blockchain/soroban.service';
import { IndexerStatus, IIndexerStatus } from '../models/IndexerStatus';
import { IndexerAlert, IIndexerAlert } from '../models/IndexerAlert';

// ─── DTOs ──────────────────────────────────────────────────────────────────────

export interface IndexerLagCheckResult {
  network: string;
  processedLedger: number;
  networkLedger: number;
  lagLedgers: number;
  thresholdLedgers: number;
  breached: boolean;
  checkedAt: string;
}

// ─── Checkpoint helpers ──────────────────────────────────────────────────────

/**
 * Fetch the indexer's persisted checkpoint for the configured network,
 * creating one seeded at the current network ledger if none exists yet
 * (first run — there is nothing to compare against otherwise).
 */
export const getOrCreateIndexerStatus = async (): Promise<IIndexerStatus> => {
  const network = stellarConfig.network;
  const existing = await IndexerStatus.findOne({ network });
  if (existing) {
    return existing;
  }

  const currentLedger = await sorobanService.getLatestLedger();
  return IndexerStatus.create({
    network,
    lastProcessedLedger: currentLedger,
    lastProcessedAt: new Date(),
  });
};

/**
 * Advance the indexer's checkpoint. Called by indexer event handlers as they
 * process ledgers so `checkIndexerLag` has an up-to-date, DB-backed view of
 * indexer progress. A no-op if `ledgerSequence` does not move the checkpoint
 * forward (handlers may process events out of strict ledger order).
 */
export const recordProcessedLedger = async (ledgerSequence: number): Promise<void> => {
  const network = stellarConfig.network;

  await IndexerStatus.findOneAndUpdate(
    { network, lastProcessedLedger: { $lt: ledgerSequence } },
    { $set: { lastProcessedLedger: ledgerSequence, lastProcessedAt: new Date() } },
    { upsert: false },
  );

  // Seed the checkpoint if this is the very first ledger ever recorded.
  await IndexerStatus.findOneAndUpdate(
    { network },
    {
      $setOnInsert: {
        network,
        lastProcessedLedger: ledgerSequence,
        lastProcessedAt: new Date(),
      },
    },
    { upsert: true },
  );
};

// ─── Webhook notification ─────────────────────────────────────────────────────

async function notifyWebhook(
  url: string,
  payload: IndexerLagCheckResult,
): Promise<{ error?: string }> {
  try {
    await axios.post(url, {
      event: 'indexer_lag_alert',
      ...payload,
    });
    return {};
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown webhook error';
    return { error: message };
  }
}

// ─── Lag check ─────────────────────────────────────────────────────────────────

/**
 * Compare the indexer's processed ledger (read from the database) against
 * the live Soroban network ledger. If the gap exceeds
 * `INDEXER_LAG_ALERT_THRESHOLD`, logs a critical alert, persists an
 * `IndexerAlert` record, and — if configured — notifies `INDEXER_LAG_WEBHOOK_URL`.
 */
export const checkIndexerLag = async (): Promise<IndexerLagCheckResult> => {
  const checkedAt = new Date().toISOString();
  const status = await getOrCreateIndexerStatus();
  const rawNetworkLedger = await sorobanService.getLatestLedger();

  // Degraded RPC answers carry no ledger information — treat them as "no
  // forward progress observed" rather than crashing the monitor loop.
  const networkLedger =
    typeof rawNetworkLedger === 'number' ? rawNetworkLedger : status.lastProcessedLedger;

  const lagLedgers = Math.max(0, networkLedger - status.lastProcessedLedger);
  const thresholdLedgers = env.INDEXER_LAG_ALERT_THRESHOLD;
  const breached = lagLedgers > thresholdLedgers;

  const result: IndexerLagCheckResult = {
    network: status.network,
    processedLedger: status.lastProcessedLedger,
    networkLedger,
    lagLedgers,
    thresholdLedgers,
    breached,
    checkedAt,
  };

  if (!breached) {
    logger.debug(
      `[Monitor] Indexer lag OK — network=${status.network} lag=${lagLedgers} ` +
        `threshold=${thresholdLedgers}`,
    );
    return result;
  }

  logger.error(
    `[Monitor] CRITICAL: indexer lag threshold breached — network=${status.network} ` +
      `processedLedger=${status.lastProcessedLedger} networkLedger=${networkLedger} ` +
      `lag=${lagLedgers} threshold=${thresholdLedgers}`,
  );

  const webhookConfigured = env.INDEXER_LAG_WEBHOOK_URL.trim().length > 0;
  let webhookNotified = false;
  let webhookError: string | undefined;

  if (webhookConfigured) {
    const outcome = await notifyWebhook(env.INDEXER_LAG_WEBHOOK_URL, result);
    webhookNotified = !outcome.error;
    webhookError = outcome.error;

    if (outcome.error) {
      logger.error(`[Monitor] Failed to notify indexer-lag webhook — error="${outcome.error}"`);
    }
  }

  await IndexerAlert.create({
    network: status.network,
    processedLedger: status.lastProcessedLedger,
    networkLedger,
    lagLedgers,
    thresholdLedgers,
    webhookConfigured,
    webhookNotified,
    webhookError,
  });

  return result;
};

// ─── Alert history ─────────────────────────────────────────────────────────────

/**
 * Fetch the most recent persisted indexer-lag alerts, newest first.
 */
export const getRecentAlerts = async (limit = 20): Promise<IIndexerAlert[]> => {
  const boundedLimit = Math.min(Math.max(limit, 1), 100);
  return IndexerAlert.find().sort({ createdAt: -1 }).limit(boundedLimit);
};

// ─── Background scheduler ───────────────────────────────────────────────────────

let monitorInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start the periodic background check on `INDEXER_LAG_CHECK_INTERVAL_MS`.
 * Safe to call once at process startup; subsequent calls are no-ops while a
 * monitor is already running.
 */
export const startIndexerLagMonitor = (): void => {
  if (monitorInterval) {
    return;
  }

  monitorInterval = setInterval(() => {
    checkIndexerLag().catch((err) => {
      const message = err instanceof Error ? err.message : 'Unknown error';
      logger.error(`[Monitor] Indexer lag check failed — error="${message}"`);
    });
  }, env.INDEXER_LAG_CHECK_INTERVAL_MS);

  monitorInterval.unref?.();

  logger.info(
    `[Monitor] Indexer lag monitor started — interval=${env.INDEXER_LAG_CHECK_INTERVAL_MS}ms ` +
      `threshold=${env.INDEXER_LAG_ALERT_THRESHOLD} ledgers`,
  );
};

/** Stop the periodic background check, if running. Primarily used by tests. */
export const stopIndexerLagMonitor = (): void => {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
};
