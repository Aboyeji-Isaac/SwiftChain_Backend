import mongoose, { Schema, Document, Types } from 'mongoose';
import { DeliveryStatus } from './Delivery';

/** Milestones on the delivery lifecycle: created -> funded -> assigned -> in_progress -> completed/cancelled. */
export enum DeliveryMilestone {
  CREATED = 'created',
  FUNDED = 'funded',
  ASSIGNED = 'assigned',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
}

/** The milestone raised when a delivery enters each status. */
export const MILESTONE_BY_STATUS: Record<DeliveryStatus, DeliveryMilestone> = {
  [DeliveryStatus.PENDING]: DeliveryMilestone.CREATED,
  [DeliveryStatus.FUNDED]: DeliveryMilestone.FUNDED,
  [DeliveryStatus.ASSIGNED]: DeliveryMilestone.ASSIGNED,
  [DeliveryStatus.IN_PROGRESS]: DeliveryMilestone.IN_PROGRESS,
  [DeliveryStatus.COMPLETED]: DeliveryMilestone.COMPLETED,
  [DeliveryStatus.CANCELLED]: DeliveryMilestone.CANCELLED,
};

export type MilestoneActorType = 'user' | 'system' | 'indexer';

export interface IMilestoneActor {
  type: MilestoneActorType;
  /** User id for `user` actors; omitted for system/indexer actors. */
  id?: string;
}

export interface IDeliveryEvent extends Document {
  delivery: Types.ObjectId;
  event: DeliveryMilestone;
  /** `null` for the initial `created` milestone. */
  fromStatus: DeliveryStatus | null;
  toStatus: DeliveryStatus;
  payload: Record<string, unknown>;
  actor: IMilestoneActor;
  occurredAt: Date;
  /** 1-based, gapless, strictly increasing per delivery. */
  seq: number;
  createdAt: Date;
}

const ActorSchema = new Schema<IMilestoneActor>(
  {
    type: { type: String, enum: ['user', 'system', 'indexer'], required: true },
    id: { type: String },
  },
  { _id: false },
);

const DeliveryEventSchema = new Schema<IDeliveryEvent>(
  {
    delivery: { type: Schema.Types.ObjectId, ref: 'Delivery', required: true },
    event: { type: String, enum: Object.values(DeliveryMilestone), required: true },
    fromStatus: { type: String, enum: [...Object.values(DeliveryStatus), null], default: null },
    toStatus: { type: String, enum: Object.values(DeliveryStatus), required: true },
    payload: { type: Schema.Types.Mixed, default: {} },
    actor: { type: ActorSchema, required: true },
    occurredAt: { type: Date, required: true, default: Date.now },
    seq: {
      type: Number,
      required: true,
      min: [1, 'seq starts at 1'],
      validate: { validator: Number.isInteger, message: 'seq must be an integer' },
    },
  },
  // Append-only log: no updatedAt, no version key.
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

// Ordering is enforced by the database: one seq per delivery, ever.
DeliveryEventSchema.index({ delivery: 1, seq: 1 }, { unique: true });
DeliveryEventSchema.index({ delivery: 1, occurredAt: 1 });

const DeliveryEvent = mongoose.model<IDeliveryEvent>('DeliveryEvent', DeliveryEventSchema);

export default DeliveryEvent;
