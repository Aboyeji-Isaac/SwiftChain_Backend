import mongoose, { Document, Schema } from 'mongoose';

export enum DlqStatus {
  PENDING = 'pending',
  RETRIED = 'retried',
  RESOLVED = 'resolved',
}

export interface IDlqEntry extends Document {
  payload: any;
  errorReason: string;
  retryCount: number;
  status: DlqStatus;
  createdAt: Date;
  updatedAt: Date;
}

const DlqEntrySchema: Schema = new Schema(
  {
    payload: {
      type: Schema.Types.Mixed,
      required: true,
    },
    errorReason: {
      type: String,
      required: true,
    },
    retryCount: {
      type: Number,
      default: 0,
    },
    status: {
      type: String,
      enum: Object.values(DlqStatus),
      default: DlqStatus.PENDING,
    },
  },
  {
    timestamps: true,
  },
);

export const DlqEntry = mongoose.model<IDlqEntry>('DlqEntry', DlqEntrySchema);
