import CircuitBreaker from 'opossum';
import logger from '../config/logger';

/**
 * Configuration options for creating a named circuit breaker.
 */
export interface CircuitBreakerOptions {
  /**
   * Human-readable name used in log messages and status payloads.
   * Should be globally unique across all circuit breakers in the app.
   */
  name: string;

  /**
   * Percentage of calls (0–100) within the rolling window that must fail
   * before the circuit transitions from CLOSED → OPEN.
   * @default 50
   */
  errorThresholdPercentage: number;

  /**
   * Duration of the rolling statistics window in milliseconds.
   * Opossum uses this window to compute the error rate.
   * @default 30000
   */
  rollingWindowMs: number;

  /**
   * Time in milliseconds the circuit stays in the OPEN state before
   * attempting a single test call (HALF-OPEN).
   * @default 60000
   */
  resetTimeoutMs: number;

  /**
   * Minimum number of calls that must occur within the rolling window before
   * the breaker is eligible to open.  Prevents spurious tripping on cold
   * start when only 1–2 calls have been made.
   * @default 5
   */
  volumeThreshold: number;

  /**
   * Per-call timeout in milliseconds.  Calls that do not resolve within this
   * window are aborted and counted as failures.
   * @default 10000
   */
  timeoutMs: number;
}

/**
 * Snapshot of a single circuit breaker's runtime state.
 * Consumed by the health endpoint at GET /api/v1/health/circuit-breakers.
 */
export interface CircuitBreakerStatus {
  name: string;
  state: 'closed' | 'open' | 'halfOpen';
  stats: {
    failures: number;
    successes: number;
    rejects: number;
    timeouts: number;
    fallbacks: number;
    fires: number;
    percentError: number;
  };
}

/**
 * Registry of every breaker created by {@link createCircuitBreaker}.
 * Keyed by the breaker's `name` so the health endpoint can iterate them.
 */
const registry = new Map<string, CircuitBreaker<unknown[], unknown>>();

/**
 * Retrieve a snapshot of all registered circuit breakers.
 * Used by the health/circuit-breakers endpoint to surface live state.
 */
export function getAllCircuitBreakerStatuses(): CircuitBreakerStatus[] {
  return Array.from(registry.values()).map((cb) => {
    const stats = cb.stats;
    return {
      name: cb.name,
      state: cb.opened ? 'open' : cb.halfOpen ? 'halfOpen' : 'closed',
      stats: {
        failures: stats.failures,
        successes: stats.successes,
        rejects: stats.rejects,
        timeouts: stats.timeouts,
        fallbacks: stats.fallbacks,
        fires: stats.fires,
        percentError:
          stats.fires > 0 ? Number(((stats.failures + stats.timeouts) / stats.fires) * 100) : 0,
      },
    };
  });
}

/**
 * Create a named, pre-configured opossum circuit breaker and register it in
 * the global registry.
 *
 * Usage:
 * ```ts
 * const cb = createCircuitBreaker<[ETARequest], ETAResponse>({
 *   name: 'google-maps',
 *   ...options,
 * });
 *
 * // Wrap a call:
 * const result = await cb.fire(request);
 * ```
 *
 * @param options - Breaker configuration (see {@link CircuitBreakerOptions}).
 * @param fallback - Optional function called when the circuit is OPEN or the
 *                   protected call throws/times out.  Receives the same
 *                   arguments as the action so it can build a meaningful
 *                   degraded response.
 * @returns A configured, event-instrumented `CircuitBreaker` instance.
 */
export function createCircuitBreaker<TArgs extends unknown[], TResult>(
  options: CircuitBreakerOptions,
  fallback?: (...args: TArgs) => TResult | Promise<TResult>,
): CircuitBreaker<TArgs, TResult> {
  const {
    name,
    errorThresholdPercentage,
    rollingWindowMs,
    resetTimeoutMs,
    volumeThreshold,
    timeoutMs,
  } = options;

  const cb = new CircuitBreaker<TArgs, TResult>(
    // The action is left as a no-op placeholder here; callers wrap their own
    // async function by passing it as the first arg to `new CircuitBreaker(fn)`
    // — but opossum also supports wrapping at `fire()` call-time via
    // `cb.fire(fn, ...args)`.  We create the breaker without a bound action so
    // the same instance can wrap any compatible function.
    async (..._args: TArgs): Promise<TResult> => {
      throw new Error(`[CircuitBreaker] ${name}: No action bound — use cb.fire(fn, ...args).`);
    },
    {
      name,
      errorThresholdPercentage,
      rollingCountTimeout: rollingWindowMs,
      resetTimeout: resetTimeoutMs,
      volumeThreshold,
      timeout: timeoutMs,
      // Allow the caller to decide whether an error counts as a failure.
      // Default: every thrown error is a failure.
      errorFilter: undefined,
    },
  );

  if (fallback) {
    cb.fallback(fallback);
  }

  // ── Event instrumentation ──────────────────────────────────────────────────

  cb.on('open', () => {
    logger.warn(`[CircuitBreaker] "${name}" OPENED — calls will be short-circuited to fallback`);
  });

  cb.on('halfOpen', () => {
    logger.info(`[CircuitBreaker] "${name}" HALF-OPEN — sending test call`);
  });

  cb.on('close', () => {
    logger.info(`[CircuitBreaker] "${name}" CLOSED — normal operation resumed`);
  });

  cb.on('fallback', (_result, ...args) => {
    logger.warn(`[CircuitBreaker] "${name}" fallback triggered`, {
      args: (args as unknown[]).map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))),
    });
  });

  cb.on('timeout', () => {
    logger.warn(`[CircuitBreaker] "${name}" call timed out after ${timeoutMs}ms`);
  });

  cb.on('reject', () => {
    logger.warn(`[CircuitBreaker] "${name}" call rejected — circuit is OPEN`);
  });

  cb.on('success', () => {
    logger.debug(`[CircuitBreaker] "${name}" call succeeded`);
  });

  cb.on('failure', (error: Error) => {
    logger.error(`[CircuitBreaker] "${name}" call failed — ${error?.message ?? error}`);
  });

  // Register in the global registry for status reporting.
  registry.set(name, cb as CircuitBreaker<unknown[], unknown>);

  logger.info(
    `[CircuitBreaker] "${name}" initialised — ` +
      `errorThreshold=${errorThresholdPercentage}% ` +
      `rollingWindow=${rollingWindowMs}ms ` +
      `resetTimeout=${resetTimeoutMs}ms ` +
      `volumeThreshold=${volumeThreshold} ` +
      `timeout=${timeoutMs}ms`,
  );

  return cb;
}

/**
 * Convenience wrapper: fire a one-off async function through the given
 * circuit breaker without permanently binding an action to it.
 *
 * Opossum v8 does not natively support passing a different function at
 * fire()-time, so we call the breaker's internal `_callFunction` by
 * monkey-patching the action just before firing and restoring it after.
 * This is the recommended pattern for "action-agnostic" breakers.
 *
 * In practice, since opossum's `fire()` always invokes the action bound at
 * construction time, we instead construct one breaker **per named action**
 * so each has its own statistics and fallback.  This helper is provided
 * for callers that already hold a reference to the breaker and need a typed
 * single-call interface.
 */
export async function fireWithBreaker<TArgs extends unknown[], TResult>(
  breaker: CircuitBreaker<TArgs, TResult>,
  action: (...args: TArgs) => Promise<TResult>,
  ...args: TArgs
): Promise<TResult> {
  // Replace the internal action for this call only.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internal = breaker as any;
  const original = internal.action;
  internal.action = action;
  try {
    return await breaker.fire(...args);
  } finally {
    internal.action = original;
  }
}
