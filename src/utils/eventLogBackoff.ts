/**
 * eventLogBackoff.ts
 *
 * Retry schedule for failed EventLog entries, shared by the event poller
 * (which schedules the first retry when a handler fails) and the EventLog
 * retry service (which schedules every later one).
 *
 * The delay doubles per attempt from `EVENTLOG_RETRY_BASE_MS` and is capped at
 * `EVENTLOG_RETRY_MAX_MS`. It is deliberately deterministic: entries fail one
 * at a time as the poller meets them, so there is no thundering herd to
 * spread out with jitter, and a predictable `nextRetryAt` is easier to reason
 * about from the admin endpoint.
 */

import env from '../config/env';

/** Delay before retry number `attempt` (1-based). */
export const eventLogRetryDelayMs = (attempt: number): number => {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(env.EVENTLOG_RETRY_BASE_MS * Math.pow(2, exponent), env.EVENTLOG_RETRY_MAX_MS);
};

/** When retry number `attempt` (1-based) becomes due, measured from `from`. */
export const nextEventLogRetryAt = (attempt: number, from: Date = new Date()): Date =>
  new Date(from.getTime() + eventLogRetryDelayMs(attempt));
