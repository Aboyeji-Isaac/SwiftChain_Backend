import mongoose, { Document, Model, Schema, Types } from 'mongoose';

export interface IReadReceipt {
  userId: Types.ObjectId | string;
  readAt: Date;
}

export interface IChatMessage extends Document {
  deliveryId?: Types.ObjectId;
  /** Delivery this message belongs to; scopes it to the `delivery:<id>` room. */
  delivery?: Types.ObjectId;
  content: string;
  sender?: string;
  /** Role of the sender at the time the message was sent. */
  senderRole?: string;
  recipients: Types.ObjectId[];
  readBy: (IReadReceipt | string | any)[];
  createdAt: Date;
}

const _ReadReceiptSchema = new Schema(
  {
    userId: { type: Schema.Types.Mixed, required: true },
    readAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const ChatMessageSchema = new mongoose.Schema(
  {
    deliveryId: { type: Schema.Types.ObjectId, ref: 'Delivery', index: true },
    delivery: { type: Schema.Types.ObjectId, ref: 'Delivery', index: true },
    content: { type: String, required: true },
    sender: { type: String },
    senderRole: { type: String },
    recipients: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    readBy: { type: [Schema.Types.Mixed], default: [] },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);

ChatMessageSchema.pre('save', function (next) {
  if (this.deliveryId && !this.delivery) {
    this.delivery = this.deliveryId;
  } else if (this.delivery && !this.deliveryId) {
    this.deliveryId = this.delivery;
  }
  next();
});

// Indexes
// 1. Per-delivery history query (ordered newest or oldest first)
ChatMessageSchema.index({ deliveryId: 1, createdAt: -1 });
ChatMessageSchema.index({ delivery: 1, createdAt: -1 });

// 2. Per-delivery read tracking index for unread queries
ChatMessageSchema.index({ deliveryId: 1, 'readBy.userId': 1 });

// 3. Global recent messages query
ChatMessageSchema.index({ createdAt: -1 });

export const ChatMessage =
  (mongoose.models.ChatMessage as Model<IChatMessage>) ||
  mongoose.model<IChatMessage>('ChatMessage', ChatMessageSchema);

export default ChatMessage;
