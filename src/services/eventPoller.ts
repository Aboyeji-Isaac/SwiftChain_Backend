/**
 * eventPoller.ts
 *
 * Continuously ingests Soroban contract events into the EventLog and hands
 * each new event to the handler registered for its topic.
 *
 * Each cycle:
 *   1. Reads the IndexerStatus checkpoint for the configured network and asks
 *      the RPC node for the latest ledger.
 *   2. Pages through `getEvents` for every subscribed topic on the contract,
 *      from the ledger after the checkpoint up to the latest ledger.
 *   3. Records each event in EventLog (deduplicated on
 *      {transactionHash, eventType}) and dispatches it to its handler.
 *   4. Marks handler failures as `failed` with the error message and schedules
 *      the first retry (`nextRetryAt`) for the EventLog retry job. A failure
 *      does not block the checkpoint.
 *   5. Advances IndexerStatus.lastProcessedLedger to the ledger it synced to.
 *
 * monitorService.checkIndexerLag compares that checkpoint with the network
 * ledger to report indexer lag.
 */

import { rpc as StellarRpc, xdr } from '@stellar/stellar-sdk';
import EventLog, { IEventLog } from '../models/EventLog';
import { IndexerStatus } from '../models/IndexerStatus';
import { escrowIndexerConfig } from '../config/escrow';
import env from '../config/env';
import logger from '../config/logger';
import { nextEventLogRetryAt } from '../utils/eventLogBackoff';
import { handleEscrowFundedEvent } from '../indexer/escrowHandlers';
import type { ISorobanRpcClient, SorobanGetEventsRequest } from './providers/sorobanRpcClient';
import { defaultSorobanRpcClient } from './providers/adapters';

// ─── Types ─────────────────────────────────────────────────────────────────────

/** Event domains recorded in EventLog (matches the model's `eventType` enum). */
export type IndexedEventType = 'delivery' | 'escrow' | 'dispute' | 'reputation' | 'milestone';

/** Routes one contract event topic to the handler for its domain. */
export interface EventSubscription {
  eventType: IndexedEventType;
  /** Contract event topic symbol, e.g. `escrow_funded`. */
  topic: string;
  handle: (event: StellarRpc.Api.EventResponse) => Promise<unknown>;
}

export interface EventPollerOptions {
  rpc: ISorobanRpcClient;
  /** Network alias the IndexerStatus checkpoint is stored under. */
  network: string;
  contractId: string;
  subscriptions: EventSubscription[];
  /** Milliseconds between poll cycles. */
  intervalMs: number;
  /** Events requested per `getEvents` page. */
  pageSize: number;
}

export interface PollCycleResult {
  fromLedger: number;
  toLedger: number;
  /** Events returned by the RPC node within the ledger window. */
  fetched: number;
  /** Events whose handler completed successfully. */
  processed: number;
  /** Events already recorded as processed or failed, so skipped. */
  duplicates: number;
  /** Events whose handler threw. They are recorded as `failed`. */
  failed: number;
}

type EventOutcome = 'processed' | 'duplicates' | 'failed';

/** The parts of an EventLog entry needed to find and re-dispatch its event. */
export type ReplayableEvent = Pick<
  IEventLog,
  'eventType' | 'transactionHash' | 'ledgerSequence' | 'eventData'
>;

/** Re-dispatches a recorded event; implemented by {@link EventPoller.replay}. */
export interface EventReplayer {
  replay(entry: ReplayableEvent): Promise<void>;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_PAGE_SIZE = 100;
const DUPLICATE_KEY_ERROR_CODE = 11000;

/** Topic filter key as the RPC node expects it: the base64 XDR of the symbol. */
const topicKey = (topic: string): string => xdr.ScVal.scvSymbol(topic).toXDR('base64');

const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: number }).code === DUPLICATE_KEY_ERROR_CODE;

// ─── Poller ────────────────────────────────────────────────────────────────────

export class EventPoller implements EventReplayer {
  private readonly options: EventPollerOptions;
  private readonly subscriptionsByTopic: Map<string, EventSubscription>;
  private readonly filters: SorobanGetEventsRequest['filters'];
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(options: EventPollerOptions) {
    this.options = options;
    this.subscriptionsByTopic = new Map(
      options.subscriptions.map((subscription) => [topicKey(subscription.topic), subscription]),
    );
    this.filters = options.subscriptions.map((subscription) => ({
      type: 'contract',
      contractIds: [options.contractId],
      topics: [[topicKey(subscription.topic), '*']],
    }));
  }

  /** Begin polling on the configured interval. Idempotent. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runCycle();
    }, this.options.intervalMs);
    void this.runCycle();
  }

  /** Stop scheduling new cycles. A cycle already in flight runs to completion. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Run one poll cycle. Errors propagate to the caller and leave the
   * checkpoint untouched, so the same ledgers are retried on the next cycle.
   */
  async pollOnce(): Promise<PollCycleResult> {
    const { network, rpc } = this.options;

    const latest = await rpc.getLatestLedger();
    const toLedger = latest.sequence;

    const checkpoint = await IndexerStatus.findOne({ network }).lean();
    // With no checkpoint yet, begin at the head rather than replaying history.
    const fromLedger = checkpoint ? checkpoint.lastProcessedLedger + 1 : toLedger;

    const result: PollCycleResult = {
      fromLedger,
      toLedger,
      fetched: 0,
      processed: 0,
      duplicates: 0,
      failed: 0,
    };

    if (fromLedger > toLedger) return result;

    for await (const event of this.fetchEvents(fromLedger, toLedger)) {
      result.fetched += 1;

      const subscription = this.subscriptionForEvent(event);
      if (!subscription) continue;

      const outcome = await this.ingest(subscription, event);
      result[outcome] += 1;
    }

    await IndexerStatus.updateOne(
      { network },
      { $set: { lastProcessedLedger: toLedger, lastProcessedAt: new Date() } },
      { upsert: true },
    );

    logger.info(
      `[EventPoller] Cycle complete — network=${network} ledgers=${fromLedger}-${toLedger} ` +
        `fetched=${result.fetched} processed=${result.processed} ` +
        `duplicates=${result.duplicates} failed=${result.failed}`,
    );

    return result;
  }

  /**
   * Re-run one recorded event through the handler registered for its topic —
   * the same dispatch path {@link ingest} uses — without touching its EventLog
   * entry; the caller owns the outcome. EventLog keeps only a reference to the
   * event, so it is fetched back from the RPC node by ledger and event id.
   *
   * @throws when the node no longer serves the event (outside its retention
   *         window), when no subscription handles its topic, or when the
   *         handler itself throws.
   */
  async replay(entry: ReplayableEvent): Promise<void> {
    const event = await this.findRecordedEvent(entry);
    if (!event) {
      throw new Error(
        `Event for tx=${entry.transactionHash} is no longer available at ledger ${entry.ledgerSequence}`,
      );
    }

    const subscription = this.subscriptionForEvent(event);
    if (!subscription || subscription.eventType !== entry.eventType) {
      throw new Error(
        `No ${entry.eventType} subscription handles the event for tx=${entry.transactionHash}`,
      );
    }

    await subscription.handle(event);
  }

  /** Find the event an EventLog entry recorded, matching on event id when one was stored. */
  private async findRecordedEvent(
    entry: ReplayableEvent,
  ): Promise<StellarRpc.Api.EventResponse | null> {
    const eventId = (entry.eventData as { eventId?: string } | null | undefined)?.eventId;

    for await (const event of this.fetchEvents(entry.ledgerSequence, entry.ledgerSequence)) {
      const matches = eventId ? event.id === eventId : event.txHash === entry.transactionHash;
      if (matches) return event;
    }
    return null;
  }

  /** Page through `getEvents` from `fromLedger`, yielding events up to `toLedger`. */
  private async *fetchEvents(
    fromLedger: number,
    toLedger: number,
  ): AsyncGenerator<StellarRpc.Api.EventResponse> {
    const { rpc, pageSize } = this.options;
    let cursor: string | undefined;

    for (;;) {
      const page = await rpc.getEvents(
        cursor
          ? { filters: this.filters, cursor, limit: pageSize }
          : { filters: this.filters, startLedger: fromLedger, limit: pageSize },
      );

      if (page.events.length === 0) return;

      for (const event of page.events) {
        // Events arrive in ledger order, so the first event past the window ends the cycle.
        if (event.ledger > toLedger) return;
        yield event;
      }

      // A cursor that does not advance would page forever.
      if (page.cursor === cursor) return;
      cursor = page.cursor;
    }
  }

  private subscriptionForEvent(event: StellarRpc.Api.EventResponse): EventSubscription | undefined {
    const first = event.topic[0];
    return first ? this.subscriptionsByTopic.get(first.toXDR('base64')) : undefined;
  }

  /**
   * Record one event and dispatch it to its handler.
   *
   * A record already marked processed or failed is skipped. A record left
   * `pending` by an interrupted earlier cycle is processed again, which is why
   * handlers must be idempotent.
   */
  private async ingest(
    subscription: EventSubscription,
    event: StellarRpc.Api.EventResponse,
  ): Promise<EventOutcome> {
    const { eventType, handle } = subscription;
    const transactionHash = event.txHash;

    const existing = await EventLog.findOne({ transactionHash, eventType }).lean();
    if (existing && existing.status !== 'pending') return 'duplicates';

    if (!existing) {
      try {
        await EventLog.create({
          eventType,
          transactionHash,
          ledgerSequence: event.ledger,
          contractId: this.options.contractId,
          eventData: { eventId: event.id, ledgerClosedAt: event.ledgerClosedAt },
          status: 'pending',
        });
      } catch (error) {
        // A concurrent writer recorded the same event between our read and write.
        if (isDuplicateKeyError(error)) return 'duplicates';
        throw error;
      }
    }

    try {
      await handle(event);
      await EventLog.markAsProcessed(transactionHash, eventType);
      return 'processed';
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await EventLog.updateOne(
        { transactionHash, eventType },
        {
          status: 'failed',
          errorMessage,
          lastError: errorMessage,
          nextRetryAt: nextEventLogRetryAt(1),
        },
      );
      logger.error(
        `[EventPoller] Handler failed — type=${eventType} tx=${transactionHash} ` +
          `ledger=${event.ledger} error="${errorMessage}"`,
      );
      return 'failed';
    }
  }

  /** Run a cycle unless one is already in flight, and log instead of throwing. */
  private runCycle(): Promise<void> {
    if (!this.inFlight) {
      this.inFlight = this.pollOnce()
        .then(
          () => undefined,
          (error: unknown) => {
            logger.error(
              `[EventPoller] Cycle failed — error="${
                error instanceof Error ? error.message : String(error)
              }"`,
            );
          },
        )
        .finally(() => {
          this.inFlight = null;
        });
    }
    return this.inFlight;
  }
}

// ─── Process-wide instance ─────────────────────────────────────────────────────

let activePoller: EventPoller | null = null;

const createDefaultPoller = (): EventPoller => {
  const { contractId, fundedEventTopic } = escrowIndexerConfig;

  return new EventPoller({
    rpc: defaultSorobanRpcClient,
    network: env.STELLAR_NETWORK,
    contractId,
    subscriptions: [
      {
        eventType: 'escrow',
        topic: fundedEventTopic,
        handle: (event) => handleEscrowFundedEvent(event, contractId),
      },
    ],
    intervalMs: DEFAULT_INTERVAL_MS,
    pageSize: DEFAULT_PAGE_SIZE,
  });
};

export const startEventPoller = (): void => {
  if (activePoller) return;

  if (!escrowIndexerConfig.contractId) {
    logger.warn('[EventPoller] ESCROW_CONTRACT_ID is not set; event polling is disabled.');
    return;
  }

  activePoller = createDefaultPoller();
  activePoller.start();
  logger.info(
    `[EventPoller] Started — network=${env.STELLAR_NETWORK} contract=${escrowIndexerConfig.contractId} ` +
      `topic=${escrowIndexerConfig.fundedEventTopic}`,
  );
};

/**
 * The replayer the EventLog retry path dispatches through: the running poller
 * when there is one, otherwise an idle poller with the same subscriptions
 * (it is never started, only used to replay). Null when no contract is
 * configured, since there is then nothing to replay against.
 */
export const getEventReplayer = (): EventReplayer | null => {
  if (activePoller) return activePoller;
  if (!escrowIndexerConfig.contractId) return null;
  return createDefaultPoller();
};

export const stopEventPoller = (): void => {
  if (!activePoller) return;

  activePoller.stop();
  activePoller = null;
  logger.info('[EventPoller] Stopped');
};
