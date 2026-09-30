import { rpc as StellarRpc } from '@stellar/stellar-sdk';
import CircuitBreaker from 'opossum';
import logger from '../config/logger';
import { stellarConfig } from '../config/stellar';
import env from '../config/env';
import { withRetry, RetryOptions } from '../utils/rpcRetry';
import { createCircuitBreaker, fireWithBreaker } from '../utils/circuitBreaker';
import type { ISorobanRpcClient } from '../services/providers/sorobanRpcClient';
import { defaultSorobanRpcClient } from '../services/providers/adapters';

/**
 * Result returned by a successful connectivity check.
 */
export interface ConnectivityCheckResult {
  connected: boolean;
  network: string;
  networkPassphrase: string;
  rpcUrl: string;
  status: string;
  latestLedger: number;
  checkedAt: string;
  latencyMs: number;
}

/**
 * Result returned when the connectivity check fails.
 */
export interface ConnectivityCheckError {
  connected: false;
  network: string;
  rpcUrl: string;
  checkedAt: string;
  error: string;
}

/**
 * Degraded ledger response returned when the Soroban circuit is OPEN.
 * Controllers should treat `degraded: true` as a signal to surface a 503.
 */
export interface DegradedLedgerResult {
  degraded: true;
  reason: string;
}

/**
 * SorobanService provides the business-logic layer for all Stellar / Soroban
 * RPC interactions, protected by a shared circuit breaker.
 *
 * Circuit-breaker behaviour:
 *   - CLOSED    — RPC calls are executed normally (with retry).
 *   - OPEN      — calls are short-circuited; fallback values are returned
 *                 immediately so the API stays responsive.
 *   - HALF-OPEN — one probe call is allowed through to test recovery.
 *
 * The circuit breaker wraps individual RPC calls rather than the service
 * methods themselves, so that `checkConnectivity()` — which already handles
 * its own errors — is not double-wrapped.
 */
export class SorobanService {
  private readonly client: ISorobanRpcClient;

  /**
   * Circuit breaker for this instance's Soroban RPC operations.
   * Typed as `CircuitBreaker<[() => Promise<unknown>], unknown>` because we
   * use `fireWithBreaker` to pass a different action on each call.
   */
  private readonly breaker: CircuitBreaker<[() => Promise<unknown>], unknown>;

  /** Counter so each service instance owns an isolated breaker. */
  private static instanceCount = 0;

  constructor(client: ISorobanRpcClient = defaultSorobanRpcClient) {
    this.client = client;

    this.breaker = createCircuitBreaker<[() => Promise<unknown>], unknown>(
      {
        // A unique name per instance keeps breaker statistics isolated (a
        // tripped breaker in one context must not short-circuit another).
        name: `soroban-rpc-${++SorobanService.instanceCount}`,
        errorThresholdPercentage: env.CB_SOROBAN_ERROR_THRESHOLD_PERCENTAGE,
        rollingWindowMs: env.CB_SOROBAN_ROLLING_WINDOW_MS,
        resetTimeoutMs: env.CB_SOROBAN_RESET_TIMEOUT_MS,
        volumeThreshold: env.CB_SOROBAN_VOLUME_THRESHOLD,
        timeoutMs: env.CB_SOROBAN_TIMEOUT_MS,
      },
      // Fallback: opossum invokes it for *any* failure, not only while the
      // circuit is OPEN. Only swallow the error into a degraded sentinel when
      // the circuit really is OPEN/half-open; otherwise rethrow so callers
      // (and tests) see the original RPC failure.
      (...fallbackArgs: unknown[]): DegradedLedgerResult => {
        if (this.breaker.opened || this.breaker.halfOpen) {
          return {
            degraded: true,
            reason:
              'Soroban RPC circuit is OPEN — the node is temporarily unreachable. ' +
              'The system will automatically retry when the circuit recovers.',
          };
        }
        const err = fallbackArgs[fallbackArgs.length - 1];
        // Rethrow the original failure untouched so callers can distinguish
        // transient RPC errors from breaker state.
        throw err;
      },
    );
  }

  // ── Retry configuration ──────────────────────────────────────────────────────

  private get retryOptions(): Pick<RetryOptions, 'maxAttempts' | 'baseDelayMs' | 'maxDelayMs'> {
    return {
      maxAttempts: env.SOROBAN_RPC_MAX_RETRIES,
      baseDelayMs: env.SOROBAN_RPC_RETRY_BASE_MS,
      maxDelayMs: env.SOROBAN_RPC_RETRY_MAX_MS,
    };
  }

  /**
   * Wrap a Soroban RPC call with:
   *   1. Exponential-backoff retry (absorbs transient failures / rate limits).
   *   2. Circuit breaker (trips when sustained failures exceed the threshold).
   */
  private async callWithRetryAndBreaker<T>(
    operationName: string,
    fn: () => Promise<T>,
  ): Promise<T | DegradedLedgerResult> {
    const retryWrapped = (): Promise<T> => withRetry(fn, { ...this.retryOptions, operationName });

    return fireWithBreaker(
      this.breaker as CircuitBreaker<[() => Promise<T>], T | DegradedLedgerResult>,
      (action: () => Promise<T>) => action(),
      retryWrapped,
    );
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Perform a live connectivity check against the Soroban RPC node.
   *
   * Calls `getHealth()` and `getLatestLedger()` in parallel.  The circuit
   * breaker wraps each call individually so a single slow call doesn't block
   * both.  This method never throws — it returns a typed error object on
   * failure so callers can decide how to respond.
   */
  public async checkConnectivity(): Promise<ConnectivityCheckResult | ConnectivityCheckError> {
    const checkedAt = new Date().toISOString();
    const start = Date.now();

    logger.debug(
      `[Soroban] Connectivity check — network=${stellarConfig.network} url=${stellarConfig.rpcUrl}`,
    );

    try {
      const [healthResult, ledgerResult] = await Promise.all([
        this.callWithRetryAndBreaker('getHealth', () => this.client.getHealth()),
        this.callWithRetryAndBreaker('getLatestLedger', () => this.client.getLatestLedger()),
      ]);

      // If either call returned a degraded sentinel the circuit is open.
      if (
        (healthResult as DegradedLedgerResult).degraded ||
        (ledgerResult as DegradedLedgerResult).degraded
      ) {
        const _latencyMs = Date.now() - start;
        logger.warn(`[Soroban] Connectivity check degraded — circuit is OPEN`);
        return {
          connected: false,
          network: stellarConfig.network,
          rpcUrl: stellarConfig.rpcUrl,
          checkedAt,
          error: 'Soroban RPC circuit breaker is OPEN — node temporarily unreachable',
        };
      }

      const health = healthResult as StellarRpc.Api.GetHealthResponse;
      const ledger = ledgerResult as StellarRpc.Api.GetLatestLedgerResponse;
      const latencyMs = Date.now() - start;

      logger.info(
        `[Soroban] Connectivity OK — network=${stellarConfig.network} ` +
          `ledger=${ledger.sequence} latency=${latencyMs}ms`,
      );

      return {
        connected: true,
        network: stellarConfig.network,
        networkPassphrase: stellarConfig.networkPassphrase,
        rpcUrl: stellarConfig.rpcUrl,
        status: health.status,
        latestLedger: ledger.sequence,
        checkedAt,
        latencyMs,
      };
    } catch (err) {
      const latencyMs = Date.now() - start;
      const message = err instanceof Error ? err.message : 'Unknown error';

      logger.error(
        `[Soroban] Connectivity FAILED — network=${stellarConfig.network} ` +
          `latency=${latencyMs}ms error="${message}"`,
      );

      return {
        connected: false,
        network: stellarConfig.network,
        rpcUrl: stellarConfig.rpcUrl,
        checkedAt,
        error: message,
      };
    }
  }

  /**
   * Fetch the latest ledger sequence number from the RPC node.
   *
   * @returns The ledger sequence number, or a {@link DegradedLedgerResult}
   *          when the circuit is OPEN.
   * @throws  When the RPC call fails and the circuit breaker's fallback itself
   *          throws (should not happen in practice).
   */
  public async getLatestLedger(): Promise<number | DegradedLedgerResult> {
    const result = await this.callWithRetryAndBreaker('getLatestLedger', () =>
      this.client.getLatestLedger(),
    );

    if ((result as DegradedLedgerResult).degraded) {
      return result as DegradedLedgerResult;
    }

    return (result as StellarRpc.Api.GetLatestLedgerResponse).sequence;
  }

  /**
   * Fetch network information (passphrase, protocol version) from the RPC node.
   *
   * @returns The raw `getNetwork` response, or a {@link DegradedLedgerResult}
   *          when the circuit is OPEN.
   */
  public async getNetworkInfo(): Promise<StellarRpc.Api.GetNetworkResponse | DegradedLedgerResult> {
    const result = await this.callWithRetryAndBreaker('getNetwork', () => this.client.getNetwork());

    return result as StellarRpc.Api.GetNetworkResponse | DegradedLedgerResult;
  }
}

/** Singleton instance for use across the application. */
export const sorobanService = new SorobanService();
