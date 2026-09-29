import logger from '../config/logger';

/**
 * Exponential-backoff retry for outbound calls, with optional per-attempt
 * timeouts.
 *
 * Used to wrap Soroban RPC calls, which fail transiently under rate limiting
 * (HTTP 429), brief node outages, and network hiccups.
 *
 * ── Why jitter ───────────────────────────────────────────────────────────────
 * Plain exponential backoff synchronises retries: when a node blips, every
 * in-flight request backs off by the same amount and they all return together,
 * re-creating the spike that caused the failure. Jitter spreads them out.
 *
 * ── Why a per-attempt timeout ────────────────────────────────────────────────
 * A hung TCP connection does not reject; it hangs until the OS gives up, which
 * can take minutes. Racing each attempt against a timer turns that hang into a
 * prompt, retryable error and bounds total latency to roughly
 * `maxAttempts * timeoutMs` plus the backoff delays.
 */

/** Reason an attempt failed, used for logging and the retry decision. */
export type AttemptFailureKind = 'timeout' | 'error';

/** Context passed to `onAttemptFailed` after each failed attempt. */
export interface RetryAttemptContext {
  /** 1-based number of the attempt that just failed. */
  attempt: number;
  /** Total attempts that will be made before giving up. */
  maxAttempts: number;
  /** Whether the attempt timed out or rejected. */
  kind: AttemptFailureKind;
  /** The error that caused the failure. */
  error: unknown;
  /** Delay before the next attempt, in ms. `0` when no retry will follow. */
  delayMs: number;
}

/** Context passed to `onRecovery` when a retried call eventually succeeds. */
export interface RetryRecoveryContext {
  /** The attempt number that succeeded (always > 1). */
  attempt: number;
  /** Total wall-clock time across all attempts, in ms. */
  elapsedMs: number;
}

/**
 * Options controlling retry/backoff behaviour for `withRetry`.
 */
export interface RetryOptions {
  /** Maximum number of attempts (including the first). Default: 5. */
  maxAttempts?: number;
  /** Base delay in milliseconds used for exponential backoff. Default: 250. */
  baseDelayMs?: number;
  /** Upper bound on any single backoff delay. Default: 8000. */
  maxDelayMs?: number;
  /** Multiplier applied to the delay on each retry. Default: 2. */
  factor?: number;
  /** Fraction of jitter (0-1) applied to each computed delay. Default: 0.2. */
  jitter?: number;
  /** Label used in log messages to identify the operation being retried. */
  operationName?: string;
  /**
   * Predicate deciding whether a given error should trigger a retry.
   * Defaults to retrying everything. Receives the failure kind as a second
   * argument so callers can treat timeouts differently from rejections.
   */
  isRetryable?: (error: unknown, kind: AttemptFailureKind) => boolean;
  /**
   * Per-attempt timeout in milliseconds. Omit or pass `0` to disable, in which
   * case an attempt waits as long as the underlying call takes.
   */
  timeoutMs?: number;
  /** Called after every failed attempt, including the last. */
  onAttemptFailed?: (context: RetryAttemptContext) => void;
  /** Called once if the call succeeds after at least one failure. */
  onRecovery?: (context: RetryRecoveryContext) => void;
}

const DEFAULT_OPTIONS: Required<
  Omit<
    RetryOptions,
    'operationName' | 'isRetryable' | 'timeoutMs' | 'onAttemptFailed' | 'onRecovery'
  >
> = {
  maxAttempts: 5,
  baseDelayMs: 250,
  maxDelayMs: 8000,
  factor: 2,
  jitter: 0.2,
};

/**
 * Error thrown when a single attempt exceeds its timeout budget.
 *
 * Distinct from a generic `Error` so callers and retry predicates can tell
 * "the node never answered" apart from "the node answered with a rejection".
 */
export class OperationTimeoutError extends Error {
  public readonly operation: string;
  public readonly timeoutMs: number;

  constructor(operation: string, timeoutMs: number) {
    super(`Operation '${operation}' timed out after ${timeoutMs}ms`);
    this.name = 'OperationTimeoutError';
    this.operation = operation;
    this.timeoutMs = timeoutMs;
    Object.setPrototypeOf(this, OperationTimeoutError.prototype);
  }
}

/** Promise-based sleep. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Race a promise against a timer.
 *
 * The timer is always cleared, including on the success path, so a pending
 * `setTimeout` cannot keep the Node event loop alive after the work is done.
 *
 * @param factory   Produces the promise to race.
 * @param timeoutMs Timeout in ms; `0` or negative disables the race.
 * @param operation Label used in the timeout message.
 */
export async function withTimeout<T>(
  factory: () => Promise<T>,
  timeoutMs: number,
  operation: string,
): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return factory();

  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new OperationTimeoutError(operation, timeoutMs)), timeoutMs);
  });

  try {
    return await Promise.race([factory(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Compute the delay for a given retry attempt using exponential backoff with
 * jitter, capped at `maxDelayMs`.
 *
 * @param attempt Zero-based retry attempt number (0 = first retry).
 */
export function computeBackoffDelay(
  attempt: number,
  options: Required<
    Omit<
      RetryOptions,
      'operationName' | 'isRetryable' | 'timeoutMs' | 'onAttemptFailed' | 'onRecovery'
    >
  >,
): number {
  const exponential = options.baseDelayMs * Math.pow(options.factor, attempt);
  const capped = Math.min(exponential, options.maxDelayMs);
  const jitterRange = capped * options.jitter;
  const jitterOffset = (Math.random() * 2 - 1) * jitterRange;
  return Math.max(0, Math.round(capped + jitterOffset));
}

/**
 * Execute `fn`, retrying with exponential backoff on failure.
 *
 * Every failed attempt is logged; once all attempts are exhausted the last
 * error is rethrown unchanged, so callers can handle it as they would an
 * unwrapped RPC failure.
 *
 * @param fn      The async operation to execute. Must be a factory rather than
 *                a promise: a promise can only be awaited, not re-run.
 * @param options Retry/backoff configuration.
 *
 * @example
 * const account = await withRetry(() => rpc.getAccount(addr), {
 *   maxAttempts: 3,
 *   timeoutMs: 10_000,
 *   operationName: 'getAccount',
 * });
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const resolved = { ...DEFAULT_OPTIONS, ...options };
  const operationName = options.operationName ?? 'rpc-call';
  const isRetryable = options.isRetryable ?? ((): boolean => true);
  const timeoutMs = options.timeoutMs ?? 0;

  const startedAt = Date.now();
  let lastError: unknown;

  for (let attempt = 0; attempt < resolved.maxAttempts; attempt += 1) {
    try {
      const result = await withTimeout(fn, timeoutMs, operationName);

      if (attempt > 0) {
        const elapsedMs = Date.now() - startedAt;
        logger.info(
          `[RPC Retry] ${operationName} recovered on attempt ${attempt + 1} after ${elapsedMs}ms`,
        );
        options.onRecovery?.({ attempt: attempt + 1, elapsedMs });
      }
      return result;
    } catch (err) {
      lastError = err;

      const attemptNumber = attempt + 1;
      const kind: AttemptFailureKind = err instanceof OperationTimeoutError ? 'timeout' : 'error';
      const isLastAttempt = attemptNumber >= resolved.maxAttempts;
      const message = err instanceof Error ? err.message : String(err);

      if (!isRetryable(err, kind) || isLastAttempt) {
        logger.error(
          `[RPC Retry] ${operationName} failed permanently after ${attemptNumber} attempt(s) — error="${message}"`,
        );
        options.onAttemptFailed?.({
          attempt: attemptNumber,
          maxAttempts: resolved.maxAttempts,
          kind,
          error: err,
          delayMs: 0,
        });
        throw err;
      }

      const delayMs = computeBackoffDelay(attempt, resolved);

      logger.warn(
        `[RPC Retry] ${operationName} attempt ${attemptNumber}/${resolved.maxAttempts} failed ` +
          `(${kind}) — error="${message}" — retrying in ${delayMs}ms`,
      );

      options.onAttemptFailed?.({
        attempt: attemptNumber,
        maxAttempts: resolved.maxAttempts,
        kind,
        error: err,
        delayMs,
      });

      await sleep(delayMs);
    }
  }

  // Unreachable in practice (loop always returns or throws), kept for type safety.
  throw lastError;
}
