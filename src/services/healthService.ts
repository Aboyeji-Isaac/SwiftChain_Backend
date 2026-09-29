/**
 * HealthService
 *
 * Business-logic layer for the comprehensive health check endpoint.
 *
 * Responsibilities:
 *   - Check MongoDB connectivity by reading Mongoose's connection readyState
 *     and issuing a lightweight `ping` command against the live connection.
 *   - Check Stellar / Soroban RPC connectivity by delegating to the existing
 *     SorobanService.checkConnectivity(), which already handles retries,
 *     circuit-breaking, and timeouts — no duplicate client is created.
 *   - Combine both results into a single HealthCheckResult DTO.
 *   - Never throw — every failure path returns a typed result so the
 *     controller can always produce a well-formed HTTP response.
 *
 * Architecture: Controller → Service (this file) → existing infrastructure
 *   (mongoose.connection, sorobanService singleton).
 */

import mongoose from 'mongoose';
import logger from '../config/logger';
import { sorobanService } from '../blockchain/soroban.service';
import type {
  ConnectivityCheckResult,
  ConnectivityCheckError,
} from '../blockchain/soroban.service';
import type {
  HealthCheckResult,
  MongoDbHealth,
  StellarRpcHealth,
  ServiceStatus,
  OverallStatus,
} from '../types/health.types';

// ─── Internal helpers ──────────────────────────────────────────────────────────

/** Map Mongoose readyState integer to a human-readable label. */
function readyStateLabel(state: number): string {
  const labels: Record<number, string> = {
    0: 'disconnected',
    1: 'connected',
    2: 'connecting',
    3: 'disconnecting',
  };
  return labels[state] ?? 'unknown';
}

/**
 * Issue a lightweight `{ ping: 1 }` command against the active Mongoose
 * connection to confirm the database is genuinely accepting queries.
 *
 * Returns `null` on success, or an error message string on failure.
 * Never throws — all errors are caught and returned as strings.
 */
async function pingMongoDB(): Promise<string | null> {
  try {
    const db = mongoose.connection.db;
    if (!db) {
      return 'No active database handle on mongoose.connection';
    }
    // maxTimeMS caps how long the server is allowed to spend on the command.
    await db.command({ ping: 1 }, { maxTimeMS: 3000 } as Parameters<typeof db.command>[1]);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : 'Unknown database error';
  }
}

// ─── MongoDB check ─────────────────────────────────────────────────────────────

/**
 * Check MongoDB connectivity.
 *
 * First checks `readyState` (synchronous — always accurate for the current
 * Mongoose lifecycle state), then issues a live `ping` command for a real
 * round-trip confirmation.
 *
 * Always resolves — failures produce `status: "unhealthy"` with an `error`
 * field rather than throwing.
 */
async function checkMongoDB(): Promise<MongoDbHealth> {
  const state = mongoose.connection.readyState;
  const label = readyStateLabel(state);

  // Fast path — Mongoose knows it is not connected; skip the network probe.
  if (state !== 1) {
    logger.warn(`[HealthService] MongoDB readyState=${state} (${label})`);
    return {
      status: 'unhealthy',
      readyState: state,
      readyStateLabel: label,
      error: `MongoDB is not connected (readyState=${state} "${label}")`,
    };
  }

  // Live probe — confirm the database is actually accepting commands.
  const pingError = await pingMongoDB();
  if (pingError) {
    logger.warn(`[HealthService] MongoDB ping failed: ${pingError}`);
    return {
      status: 'unhealthy',
      readyState: state,
      readyStateLabel: label,
      error: pingError,
    };
  }

  logger.debug('[HealthService] MongoDB ping OK');
  return {
    status: 'healthy',
    readyState: state,
    readyStateLabel: label,
  };
}

// ─── Stellar RPC check ─────────────────────────────────────────────────────────

/**
 * Check Stellar / Soroban RPC connectivity.
 *
 * Delegates entirely to the existing SorobanService singleton which already
 * wraps the check in circuit-breaking + exponential-backoff retry, so no
 * duplicate client or connection is created here.
 *
 * Always resolves — failures produce `status: "unhealthy"` with an `error`
 * field rather than throwing.
 */
async function checkStellarRpc(): Promise<StellarRpcHealth> {
  const result: ConnectivityCheckResult | ConnectivityCheckError =
    await sorobanService.checkConnectivity();

  if (result.connected) {
    const healthy = result as ConnectivityCheckResult;
    logger.debug(
      `[HealthService] Stellar RPC OK — network=${healthy.network} ledger=${healthy.latestLedger}`,
    );
    return {
      status: 'healthy',
      network: healthy.network,
      latestLedger: healthy.latestLedger,
      latencyMs: healthy.latencyMs,
      checkedAt: healthy.checkedAt,
    };
  }

  const unhealthy = result as ConnectivityCheckError;
  logger.warn(`[HealthService] Stellar RPC unhealthy — error="${unhealthy.error}"`);
  return {
    status: 'unhealthy',
    network: unhealthy.network,
    checkedAt: unhealthy.checkedAt,
    // Surface the error message but never the RPC URL or any credential.
    error: unhealthy.error,
  };
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Run all service health checks in parallel and return a combined result.
 *
 * Both checks run concurrently via `Promise.all` so a slow dependency does
 * not delay reporting the state of the other.
 *
 * The overall status is `"healthy"` only when every required service is
 * healthy; it degrades to `"degraded"` as soon as any service is unhealthy.
 */
export async function checkHealth(): Promise<HealthCheckResult> {
  const timestamp = new Date().toISOString();
  const uptime = process.uptime();

  const [mongodb, stellarRpc] = await Promise.all([checkMongoDB(), checkStellarRpc()]);

  const serviceStatuses: ServiceStatus[] = [mongodb.status, stellarRpc.status];
  const overall: OverallStatus = serviceStatuses.every((s) => s === 'healthy')
    ? 'healthy'
    : 'degraded';

  logger.info(
    `[HealthService] Health check complete — overall=${overall} ` +
      `mongodb=${mongodb.status} stellarRpc=${stellarRpc.status}`,
  );

  return {
    status: overall,
    services: {
      mongodb,
      stellarRpc,
    },
    timestamp,
    uptime,
  };
}
