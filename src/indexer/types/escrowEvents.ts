/**
 * Typed interfaces for Soroban escrow resolution events.
 * Both escrow_released and escrow_refunded events follow the same base shape.
 */

/** Event type for escrow resolution (release or refund) */
export type EscrowResolutionEventType = 'escrow_released' | 'escrow_refunded';

/**
 * Typed representation of an escrow resolution event from the Soroban indexer.
 * Emitted when an escrow is either released to the buyer or refunded to the seller.
 */
export interface EscrowResolvedEvent {
  /** Soroban contract event type: 'escrow_released' or 'escrow_refunded' */
  type: EscrowResolutionEventType;

  /** MongoDB ObjectId or internal escrow identifier */
  escrowId: string;

  /** Stellar transaction hash of the settlement transaction */
  transactionHash: string;

  /** Amount settled (as string to preserve precision) */
  amount: string;

  /** Token/asset identifier (e.g. 'XLM', 'USDC') */
  asset: string;

  /** Ledger sequence number when the event occurred */
  ledger: number;

  /** Unix timestamp of the ledger close time */
  timestamp: number;

  /** The recipient of the settlement funds (buyer on release, seller on refund) */
  recipient: string;
}

/** Valid escrow statuses matching the Escrow model enum */
export type EscrowStatus = 'pending' | 'locked' | 'released' | 'refunded' | 'disputed';

/** Terminal statuses that cannot transition further */
export const TERMINAL_STATUSES: ReadonlySet<EscrowStatus> = new Set(['released', 'refunded']);
