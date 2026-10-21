/**
 * eventLogRetryService.ts
 *
 * Closes the loop on indexer events whose handler failed. The event poller
 * records such an entry as `failed` and schedules its first retry
 * (`nextRetryAt`); from there this service owns it:
 *
 *   failed ──(due / admin retry)──► replayed through the poller's dispatch path
 *     ├─ handler succeeds ──► processed
 *     ├─ handler fails, attempts left ──► failed, nextRetryAt = backoff
 *     └─ handler fails, attempts exhausted ──► failed, deadLetteredAt set,
 *                                              escalated to the DLQ
 *
 * ── Concurrency ───────────────────────────────────────────────────────────────
 * Every attempt first claims the entry with a conditional update that matches
 * the `nextRetryAt` value it read and moves it forward by a lease. A sweep on
 * another instance, or an admin retry racing the sweep, then fails to match
 * and skips the entry instead of running the handler twice. The attempt's own
 * outcome overwrites the lease.
 */

import { StatusCodes } from 'http-status-codes';
import { Types } from 'mongoose';
import EventLog, { IEventLog } from '../models/EventLog';
import AuditLog from '../models/AuditLog';
import { DlqEntry, DlqStatus } from '../models/DlqEntry';
import { dlqService } from './dlqService';
import { getEventReplayer, EventReplayer } from './eventPoller';
import { nextEventLogRetryAt } from '../utils/eventLogBackoff';
import AppError from '../utils/AppError';
import logger from '../config/logger';
import env from '../config/env';

// ─── Types ─────────────────────────────────────────────────────────────────────

export type EventLogRetryOutcome = 'processed' | 'scheduled' | 'dead_lettered';

export interface EventLogRetryResult {
  outcome: EventLogRetryOutcome;
  event: IEventLog;
}

export interface FailedEventLogPage {
  data: IEventLog[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface EventLogRetrySweepResult {
  /** Due entries this sweep claimed and replayed. */
  attempted: number;
  processed: number;
  rescheduled: number;
  deadLettered: number;
}

/** DLQ payload for an escalated EventLog entry; `type` routes DLQ retries back here. */
export interface EventLogDlqPayload {
  type: 'eventlog';
  eventLogId: string;
  eventType: string;
  transactionHash: string;
  ledgerSequence: number;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

/** How long a claimed entry is hidden from other retriers while its attempt runs. */
const CLAIM_LEASE_MS = 5 * 60 * 1000;

const errorMessageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// ─── Service ───────────────────────────────────────────────────────────────────

export class EventLogRetryService {
  /**
   * @param resolveReplayer Supplies the replayer per attempt; by default the
   *        running event poller (or an idle one with the same subscriptions).
   */
  constructor(
    private readonly resolveReplayer: () => EventReplayer | null = () => getEventReplayer(),
  ) {}

  /** Failed entries, newest failure first, including dead-lettered ones. */
  async listFailed(page = 1, limit = 20): Promise<FailedEventLogPage> {
    const safePage = Math.max(1, Math.floor(page) || 1);
    const safeLimit = Math.min(Math.max(1, Math.floor(limit) || 20), 100);
    const query = { status: 'failed' };

    const [data, total] = await Promise.all([
      EventLog.find(query)
        .sort({ updatedAt: -1 })
        .skip((safePage - 1) * safeLimit)
        .limit(safeLimit),
      EventLog.countDocuments(query),
    ]);

    return {
      data,
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit),
    };
  }

  /**
   * Retry one failed entry now, regardless of its backoff window. Allowed
   * for dead-lettered entries too, so an operator can re-drive one after
   * fixing the underlying cause. Audit-logged against `actorId`.
   *
   * @throws {AppError} 400 invalid id · 404 unknown entry · 409 not failed, or
   *         already being retried · 503 no contract configured to replay against.
   */
  async retryById(id: string, actorId?: string | null): Promise<EventLogRetryResult> {
    if (!Types.ObjectId.isValid(id)) {
      throw new AppError('Invalid event log ID', StatusCodes.BAD_REQUEST);
    }

    const entry = await EventLog.findById(id);
    if (!entry) {
      throw new AppError('Event log entry not found', StatusCodes.NOT_FOUND);
    }
    if (entry.status !== 'failed') {
      throw new AppError(
        `Only failed event log entries can be retried; this one is '${entry.status}'.`,
        StatusCodes.CONFLICT,
      );
    }

    const replayer = this.requireReplayer();
    const claimed = await this.claim(entry);
    if (!claimed) {
      throw new AppError('This event log entry is already being retried.', StatusCodes.CONFLICT);
    }

    const result = await this.attempt(claimed, replayer);
    await this.writeAuditLog('eventlog.retry', actorId ?? null, result.event, {
      outcome: result.outcome,
      retries: result.event.retries,
      lastError: result.event.lastError ?? null,
    });
    return result;
  }

  /**
   * Retry every failed entry whose backoff window has elapsed, oldest due
   * first, up to `EVENTLOG_RETRY_BATCH_SIZE`. Dead-lettered entries are left
   * for an operator. Used by the EventLog retry job.
   */
  async retryDue(now: Date = new Date()): Promise<EventLogRetrySweepResult> {
    const result: EventLogRetrySweepResult = {
      attempted: 0,
      processed: 0,
      rescheduled: 0,
      deadLettered: 0,
    };

    const replayer = this.resolveReplayer();
    if (!replayer) {
      logger.warn('[EventLogRetry] No contract configured to replay against; sweep skipped.');
      return result;
    }

    const due = await EventLog.find({
      status: 'failed',
      deadLetteredAt: null,
      nextRetryAt: { $ne: null, $lte: now },
    })
      .sort({ nextRetryAt: 1 })
      .limit(env.EVENTLOG_RETRY_BATCH_SIZE);

    for (const entry of due) {
      const claimed = await this.claim(entry);
      if (!claimed) continue; // picked up elsewhere since the read

      result.attempted += 1;
      const { outcome } = await this.attempt(claimed, replayer);
      if (outcome === 'processed') result.processed += 1;
      else if (outcome === 'scheduled') result.rescheduled += 1;
      else result.deadLettered += 1;
    }

    return result;
  }

  /**
   * Atomically take a failed entry for one attempt by pushing `nextRetryAt`
   * out by the claim lease. The update only matches the `nextRetryAt` value
   * this retrier read, so whichever retrier moves it first wins and every
   * other one gets null, whatever their clocks say.
   */
  private async claim(entry: IEventLog): Promise<IEventLog | null> {
    return EventLog.findOneAndUpdate(
      { _id: entry._id, status: 'failed', nextRetryAt: entry.nextRetryAt ?? null },
      { $set: { nextRetryAt: new Date(Date.now() + CLAIM_LEASE_MS) } },
      { new: true },
    );
  }

  /** Replay a claimed entry and record the outcome on it. */
  private async attempt(entry: IEventLog, replayer: EventReplayer): Promise<EventLogRetryResult> {
    const attemptNumber = entry.retries + 1;
    const now = new Date();

    try {
      await replayer.replay(entry);
    } catch (error) {
      return this.recordFailure(entry, attemptNumber, errorMessageOf(error), now);
    }

    const event = await EventLog.findByIdAndUpdate(
      entry._id,
      {
        $set: {
          status: 'processed',
          processedAt: now,
          retries: attemptNumber,
          errorMessage: null,
          nextRetryAt: null,
        },
      },
      { new: true },
    );

    // An entry re-driven after escalation no longer needs its DLQ record.
    if (entry.deadLetteredAt) {
      await DlqEntry.updateMany(
        { 'payload.type': 'eventlog', 'payload.eventLogId': String(entry._id) },
        { $set: { status: DlqStatus.RESOLVED } },
      );
    }

    logger.info(
      `[EventLogRetry] Retry succeeded — id=${String(entry._id)} type=${entry.eventType} ` +
        `tx=${entry.transactionHash} attempt=${attemptNumber}`,
    );
    return { outcome: 'processed', event: event ?? entry };
  }

  private async recordFailure(
    entry: IEventLog,
    attemptNumber: number,
    message: string,
    now: Date,
  ): Promise<EventLogRetryResult> {
    const exhausted = attemptNumber >= env.EVENTLOG_RETRY_MAX_ATTEMPTS;
    const escalate = exhausted && !entry.deadLetteredAt;

    const event = await EventLog.findByIdAndUpdate(
      entry._id,
      {
        $set: {
          retries: attemptNumber,
          errorMessage: message,
          lastError: message,
          nextRetryAt: exhausted ? null : nextEventLogRetryAt(attemptNumber + 1, now),
          ...(escalate ? { deadLetteredAt: now } : {}),
        },
      },
      { new: true },
    );
    const updated = event ?? entry;

    if (!exhausted) {
      logger.warn(
        `[EventLogRetry] Retry failed — id=${String(entry._id)} attempt=${attemptNumber}/` +
          `${env.EVENTLOG_RETRY_MAX_ATTEMPTS} next=${updated.nextRetryAt?.toISOString()} ` +
          `error="${message}"`,
      );
      return { outcome: 'scheduled', event: updated };
    }

    if (escalate) {
      const payload: EventLogDlqPayload = {
        type: 'eventlog',
        eventLogId: String(entry._id),
        eventType: entry.eventType,
        transactionHash: entry.transactionHash,
        ledgerSequence: entry.ledgerSequence,
      };
      await dlqService.addEntry(payload, message);
      await this.writeAuditLog('eventlog.dead_lettered', null, updated, {
        retries: attemptNumber,
        lastError: message,
      });
    }

    logger.error(
      `[EventLogRetry] Retries exhausted — id=${String(entry._id)} type=${entry.eventType} ` +
        `tx=${entry.transactionHash} attempts=${attemptNumber} error="${message}"`,
    );
    return { outcome: 'dead_lettered', event: updated };
  }

  private requireReplayer(): EventReplayer {
    const replayer = this.resolveReplayer();
    if (!replayer) {
      throw new AppError(
        'Event retries are unavailable: no escrow contract is configured to replay against.',
        StatusCodes.SERVICE_UNAVAILABLE,
      );
    }
    return replayer;
  }

  private async writeAuditLog(
    action: string,
    actorId: string | null,
    entry: IEventLog,
    meta: Record<string, unknown>,
  ): Promise<void> {
    try {
      await AuditLog.create({
        action,
        actor: actorId && Types.ObjectId.isValid(actorId) ? new Types.ObjectId(actorId) : null,
        targetType: 'EventLog',
        targetId: entry._id,
        description: `${entry.eventType} event tx=${entry.transactionHash}`,
        meta,
      });
    } catch (error) {
      logger.error(
        `[EventLogRetry] Failed to write audit log for event log ${String(entry._id)}: ` +
          errorMessageOf(error),
      );
    }
  }
}

export const eventLogRetryService = new EventLogRetryService();
export default eventLogRetryService;
