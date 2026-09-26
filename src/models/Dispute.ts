import mongoose, { Schema, Document } from 'mongoose';

export enum DisputeReason {
  DAMAGED_PACKAGE = 'damaged_package',
  LATE_DELIVERY = 'late_delivery',
  WRONG_ITEM = 'wrong_item',
  NON_DELIVERY = 'non_delivery',
  OTHER = 'other',
}

export enum DisputeStatus {
  OPEN = 'open',
  UNDER_REVIEW = 'under_review',
  RESOLVED = 'resolved',
  REJECTED = 'rejected',
}

export interface IDispute extends Document {
  /** On-chain dispute identifier (bytes32 string from the Soroban contract). */
  disputeId?: string;
  deliveryId: string;
  /** Stellar address that opened the dispute on-chain. */
  openedBy?: string;
  raisedBy: string;
  reason: DisputeReason;
  description: string;
  evidenceUrls: string[];
  status: DisputeStatus;
  /** Ledger sequence at which the dispute was opened on-chain. */
  openedLedger?: number;
  raisedAtLedger?: number;
  /** Resolution note recorded when the dispute is closed on-chain. */
  resolution?: string;
  /** Ledger sequence at which the dispute was resolved on-chain. */
  resolvedLedger?: number;
  resolvedAt?: Date;
  resolvedBy?: string;
  resolutionNotes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const DisputeSchema = new Schema<IDispute>(
  {
    disputeId: { type: String, index: true, sparse: true },
    deliveryId: { type: String, required: true, index: true },
    openedBy: { type: String, trim: true },
    raisedBy: { type: String, required: true, index: true },
    reason: {
      type: String,
      enum: Object.values(DisputeReason),
      required: true,
    },
    description: { type: String, required: true },
    evidenceUrls: { type: [String], default: () => [] },
    status: {
      type: String,
      enum: Object.values(DisputeStatus),
      default: DisputeStatus.OPEN,
      index: true,
    },
    openedLedger: { type: Number },
    raisedAtLedger: { type: Number },
    resolution: { type: String },
    resolvedLedger: { type: Number },
    resolvedAt: { type: Date },
    resolvedBy: { type: String },
    resolutionNotes: { type: String },
  },
  { timestamps: true },
);

DisputeSchema.index({ deliveryId: 1, status: 1 });
DisputeSchema.index({ raisedBy: 1, createdAt: -1 });
DisputeSchema.index({ status: 1, createdAt: -1 });
DisputeSchema.index({ disputeId: 1 }, { unique: true, sparse: true });

const Dispute = mongoose.model<IDispute>('Dispute', DisputeSchema);

export default Dispute;
export { Dispute };
