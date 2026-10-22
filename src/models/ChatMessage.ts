import mongoose, { Document, Model, Schema, Types } from 'mongoose';

export interface IReadReceipt {
  userId: Types.ObjectId | string;
  readAt: Date;
}

export interface IChatMessage extends Document {
  deliveryId?: Types.ObjectId;
  content: string;
  sender?: string;
  recipients: Types.ObjectId[];
  readBy: IReadReceipt[];
  createdAt: Date;
}

const ReadReceiptSchema = new Schema(
  {
    userId: { type: Schema.Types.Mixed, required: true },
    readAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const ChatMessageSchema = new mongoose.Schema(
  {
    deliveryId: { type: Schema.Types.ObjectId, ref: 'Delivery', index: true },
    content: { type: String, required: true },
    sender: { type: String },
    recipients: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    readBy: { type: [ReadReceiptSchema], default: [] },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);

// Indexes
// 1. Per-delivery history query (ordered newest or oldest first)
ChatMessageSchema.index({ deliveryId: 1, createdAt: -1 });

// 2. Per-delivery read tracking index for unread queries
ChatMessageSchema.index({ deliveryId: 1, 'readBy.userId': 1 });

// 3. getRecentMessages (src/sockets/socketService.ts) runs on every socket
// connection: an unfiltered find sorted by createdAt desc, limited to 10.
ChatMessageSchema.index({ createdAt: -1 });

export const ChatMessage =
  (mongoose.models.ChatMessage as Model<IChatMessage>) ||
  mongoose.model<IChatMessage>('ChatMessage', ChatMessageSchema);

export default ChatMessage;
