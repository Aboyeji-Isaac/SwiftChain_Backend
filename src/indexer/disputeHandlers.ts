import logger from '../config/logger';
import axios from 'axios';
import env from '../config/env';
import { disputeService } from '../services/disputeService';

/**
 * Parsed representation of a `dispute_opened` event emitted by
 * the SwiftChain Soroban contract.
 * Contract topics: [event_type, dispute_id, delivery_id]
 * Contract data:   { opened_by: address, reason?: string }
 */
export interface DisputeOpenedEvent {
  disputeId: string;
  deliveryId: string;
  openedBy?: string;
  reason?: string;
  ledgerSequence: number;
}

/**
 * Parsed representation of a `dispute_resolved` event emitted by
 * the SwiftChain Soroban contract.
 * Contract topics: [event_type, dispute_id]
 * Contract data:   { resolution?: string }
 */
export interface DisputeResolvedEvent {
  disputeId: string;
  resolution?: string;
  ledgerSequence: number;
}

/**
 * Handle a `dispute_opened` event: creates the local Dispute record and
 * fires a notification so support staff can act on it.
 */
export async function handleDisputeOpened(event: DisputeOpenedEvent): Promise<void> {
  if (!event.disputeId || !event.deliveryId) {
    logger.warn('[disputeHandlers] dispute_opened: invalid event payload', { event });
    return;
  }

  try {
    await disputeService.openDispute({
      disputeId: event.disputeId,
      deliveryId: event.deliveryId,
      openedBy: event.openedBy,
      reason: event.reason,
      ledgerSequence: event.ledgerSequence,
    });

    if (env.DISPUTE_NOTIFICATION_WEBHOOK_URL) {
      await axios
        .post(env.DISPUTE_NOTIFICATION_WEBHOOK_URL, {
          event: 'dispute_opened',
          disputeId: event.disputeId,
          deliveryId: event.deliveryId,
          ledgerSequence: event.ledgerSequence,
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn(`[disputeHandlers] dispute_opened webhook failed: ${message}`);
        });
    }
  } catch (err) {
    logger.error('[disputeHandlers] dispute_opened: failed to persist dispute', {
      disputeId: event.disputeId,
      ledgerSequence: event.ledgerSequence,
      error: err,
    });
    throw err;
  }
}

/**
 * Handle a `dispute_resolved` event: updates the local Dispute status and
 * fires a notification. A resolution for an unknown dispute is treated as a
 * data-ordering anomaly (logged, not thrown) rather than an error, since
 * the indexer may observe events out of strict ledger order.
 */
export async function handleDisputeResolved(event: DisputeResolvedEvent): Promise<void> {
  if (!event.disputeId) {
    logger.warn('[disputeHandlers] dispute_resolved: invalid event payload', { event });
    return;
  }

  try {
    await disputeService.resolveDispute({
      disputeId: event.disputeId,
      resolution: event.resolution,
      ledgerSequence: event.ledgerSequence,
    });

    if (env.DISPUTE_NOTIFICATION_WEBHOOK_URL) {
      await axios
        .post(env.DISPUTE_NOTIFICATION_WEBHOOK_URL, {
          event: 'dispute_resolved',
          disputeId: event.disputeId,
          resolution: event.resolution,
          ledgerSequence: event.ledgerSequence,
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn(`[disputeHandlers] dispute_resolved webhook failed: ${message}`);
        });
    }
  } catch (err) {
    logger.error('[disputeHandlers] dispute_resolved: failed to update dispute', {
      disputeId: event.disputeId,
      ledgerSequence: event.ledgerSequence,
      error: err,
    });
    throw err;
  }
}

/**
 * Route an incoming dispute event by its type string to the correct
 * handler. Unknown event types are logged and ignored.
 */
export async function dispatchDisputeEvent(
  eventType: string,
  event: DisputeOpenedEvent | DisputeResolvedEvent,
): Promise<void> {
  switch (eventType) {
    case 'dispute_opened':
      await handleDisputeOpened(event as DisputeOpenedEvent);
      break;
    case 'dispute_resolved':
      await handleDisputeResolved(event as DisputeResolvedEvent);
      break;
    default:
      logger.warn('[disputeHandlers] unknown event type, ignoring', { eventType });
  }
}
