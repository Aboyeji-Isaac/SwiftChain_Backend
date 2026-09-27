// src/models/Escrow.ts
import mongoose, { Schema, Document, Model, Types } from 'mongoose';

/** Lifecycle of funds held in a Soroban escrow contract for a delivery. */
export enum EscrowStatus {
  PENDING = 'pending',
  LOCKED = 'locked',
  RELEASED = 'released',
  REFUNDED = 'refunded',
  DISPUTED = 'disputed',
  /** Lock TTL elapsed without resolution — flagged for admin review. */
  EXPIRED = 'expired',
  /** An admin closed out an expired escrow. */
  RESOLVED = 'resolved',
}

/** Alias for lock status – kept for backward compatibility. */
export enum EscrowLockStatus {
  PENDING = 'pending',
  LOCKED = 'locked',
  RELEASED = 'released',
  REFUNDED = 'refunded',
  DISPUTED = 'disputed',
}

/** Escrow states in which funds are actually held by the contract. */
const FUNDS_HELD_STATUSES: ReadonlySet<EscrowStatus> = new Set([
  EscrowStatus.LOCKED,
  EscrowStatus.DISPUTED,
]);

/** Escrow states that can no longer change. */
const TERMINAL_STATUSES: ReadonlySet<EscrowStatus> = new Set([
  EscrowStatus.RELEASED,
  EscrowStatus.REFUNDED,
  EscrowStatus.RESOLVED,
]);

/** The kind of on‑chain operation a recorded transaction hash represents. */
export type EscrowTransactionType = 'fund' | 'release' | 'refund';

export interface IEscrowTransaction {
  hash: string;
  type: EscrowTransactionType;
  ledger?: number;
  recordedAt: Date;
}

export interface IEscrow extends Document {
  /** Reference to the delivery this escrow secures. */
  delivery: Types.ObjectId;
  /** Current escrow lifecycle state. */
  status: EscrowStatus;
  /** Escrowed amount, denominated in `assetCode` units (not stroops). */
  amount: number;
  /** Asset code of the escrowed funds (e.g. `XLM`, `USDC`). */
  assetCode: string;
  /** Issuer account for non‑native assets. */
  assetIssuer?: string;
  /** Soroban contract id (`C...`) holding the funds. */
  contractId?: string;
  /** Stellar account funding the escrow. */
  payerAddress?: string;
  /** Stellar account entitled to the funds on release. */
  payeeAddress?: string;
  /** Transaction hash of the successful lock invocation. */
  lockTransactionHash?: string;
  /** Transaction hash of the successful release invocation. */
  releaseTransactionHash?: string;
  /** Transaction hash of the successful refund invocation. */
  refundTransactionHash?: string;
  lockedAt?: Date;
  releasedAt?: Date;
  refundedAt?: Date;
  /** Ledger sequence of the last on‑chain event applied to this record. */
  lastSyncedLedger?: number;
  /** Reason recorded when the escrow moved to `disputed`. */
  disputeReason?: string;
  /** Expiry, flagging and resolution audit fields for the escrow lifecycle. */
  /** Absolute point in time after which the lock is considered stale. */
  expiresAt?: Date;
  /** When the expiry scan flagged the escrow. */
  flaggedAt?: Date;
  /** Soroban ledger sequence at which the expiry was detected (audit trail). */
  flaggedLedger?: number;
  /** When an admin resolved the expired escrow. */
  resolvedAt?: Date;
  /** Admin who resolved the expired escrow. */
  resolvedBy?: string;
  /** Admin-provided audit note describing the resolution. */
  resolutionNotes?: string;
  /** Timestamp fields provided by Mongoose. */
  createdAt: Date;
  updatedAt: Date;
  /** Collection of on‑chain transaction hashes. */
  transactions: IEscrowTransaction[];
  /** Virtuals */
  readonly isFundsLocked: boolean;
  readonly isSettled: boolean;
}

// Schema definitions
const EscrowTransactionSchema = new Schema<IEscrowTransaction>(
  {
    hash: { type: String, required: true, trim: true },
    type: { type: String, enum: ['fund', 'release', 'refund'], required: true },
    ledger: { type: Number },
    recordedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const EscrowSchema = new Schema<IEscrow>(
  {
    delivery: {
      type: Schema.Types.ObjectId,
      ref: 'Delivery',
      required: true,
      unique: true,
      index: true,
    },
    status: {
      type: String,
      enum: Object.values(EscrowStatus),
      default: EscrowStatus.PENDING,
      required: true,
      index: true,
    },
    amount: { type: Number, required: true, min: 0 },
    assetCode: { type: String, required: true, trim: true, uppercase: true, maxlength: 12 },
    assetIssuer: { type: String, trim: true },
    // Unique: one on-chain escrow contract backs at most one escrow record.
    contractId: { type: String, trim: true, unique: true, sparse: true },
    payerAddress: { type: String, trim: true },
    payeeAddress: { type: String, trim: true },
    lockTransactionHash: { type: String, trim: true },
    releaseTransactionHash: { type: String, trim: true },
    refundTransactionHash: { type: String, trim: true },
    lockedAt: { type: Date },
    releasedAt: { type: Date },
    refundedAt: { type: Date },
    lastSyncedLedger: { type: Number, min: 0 },
    disputeReason: { type: String, trim: true },
    expiresAt: { type: Date, index: true },
    flaggedAt: { type: Date },
    flaggedLedger: { type: Number, min: 0 },
    resolvedAt: { type: Date },
    resolvedBy: { type: String, trim: true },
    resolutionNotes: { type: String, trim: true },
    transactions: { type: [EscrowTransactionSchema], default: [] },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(_doc, ret: Record<string, unknown>) {
        ret.id = ret._id;
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
    toObject: { virtuals: true },
  },
);

// Virtuals
EscrowSchema.virtual('isFundsLocked').get(function (this: IEscrow) {
  return FUNDS_HELD_STATUSES.has(this.status);
});
EscrowSchema.virtual('isSettled').get(function (this: IEscrow) {
  return TERMINAL_STATUSES.has(this.status);
});

// Ensure transaction hash uniqueness across escrows
EscrowSchema.index({ 'transactions.hash': 1 }, { unique: true, sparse: true });

const Escrow: Model<IEscrow> =
  (mongoose.models.Escrow as Model<IEscrow>) || mongoose.model<IEscrow>('Escrow', EscrowSchema);

export default Escrow;
export { Escrow };
