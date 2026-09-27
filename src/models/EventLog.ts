import mongoose, { Schema, Document, Model } from 'mongoose';

export interface IEventLog extends Document {
  eventType: string;
  transactionHash: string;
  ledgerSequence: number;
  contractId?: string;
  eventData?: Record<string, any>;
  processedAt: Date | null;
  status: 'pending' | 'processed' | 'failed';
  errorMessage?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// Define static methods interface
interface IEventLogModel extends Model<IEventLog> {
  markAsProcessed(transactionHash: string, eventType: string): Promise<IEventLog | null>;
  getLastProcessedLedger(eventType?: string): Promise<number>;
  eventExists(transactionHash: string, eventType: string): Promise<boolean>;
}

const EventLogSchema = new Schema<IEventLog, IEventLogModel>(
  {
    eventType: {
      type: String,
      required: [true, 'Event type is required'],
      enum: ['delivery', 'escrow', 'dispute', 'reputation', 'milestone'],
      index: true,
    },
    transactionHash: {
      type: String,
      required: [true, 'Transaction hash is required'],
      index: true,
      trim: true,
    },
    ledgerSequence: {
      type: Number,
      required: [true, 'Ledger sequence is required'],
      index: true,
      min: [0, 'Ledger sequence must be a positive number'],
    },
    contractId: {
      type: String,
      index: true,
      trim: true,
      default: null,
    },
    eventData: {
      type: Schema.Types.Mixed,
      default: null,
    },
    processedAt: {
      type: Date,
      default: null,
    },
    status: {
      type: String,
      required: [true, 'Status is required'],
      enum: ['pending', 'processed', 'failed'],
      default: 'pending',
      index: true,
    },
    errorMessage: {
      type: String,
      trim: true,
      default: null,
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_, ret) => {
        ret.id = ret._id;
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  },
);

// Compound index to prevent duplicate processing
EventLogSchema.index({ transactionHash: 1, eventType: 1 }, { unique: true });

// Index for efficient querying of unprocessed events
EventLogSchema.index({ status: 1, createdAt: 1 });

// Index for ledger sequence range queries
EventLogSchema.index({ ledgerSequence: 1, eventType: 1 });

// Pre-save middleware to set processedAt if status is processed
EventLogSchema.pre<IEventLog>('save', function (next) {
  if (this.status === 'processed' && !this.processedAt) {
    this.processedAt = new Date();
  }
  next();
});

// Static method to mark events as processed
EventLogSchema.static(
  'markAsProcessed',
  async function (
    this: IEventLogModel,
    transactionHash: string,
    eventType: string,
  ): Promise<IEventLog | null> {
    return this.findOneAndUpdate(
      { transactionHash, eventType },
      { status: 'processed', processedAt: new Date() },
      { new: true },
    );
  },
);

// Static method to get the last processed ledger sequence
EventLogSchema.static(
  'getLastProcessedLedger',
  async function (this: IEventLogModel, eventType?: string): Promise<number> {
    const query = eventType ? { eventType, status: 'processed' } : { status: 'processed' };
    const lastEvent = await this.findOne(query).sort({ ledgerSequence: -1 }).limit(1);
    return lastEvent?.ledgerSequence || 0;
  },
);

// Static method to check if an event already exists
EventLogSchema.static(
  'eventExists',
  async function (
    this: IEventLogModel,
    transactionHash: string,
    eventType: string,
  ): Promise<boolean> {
    const event = await this.findOne({ transactionHash, eventType });
    return !!event;
  },
);

const EventLog = mongoose.model<IEventLog, IEventLogModel>('EventLog', EventLogSchema);

export default EventLog;
