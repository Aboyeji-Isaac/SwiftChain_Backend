import mongoose, { Document, Model, Schema, Types } from 'mongoose';

export interface IChatMessage extends Document {
  content: string;
  sender?: string;
  /** Delivery this message belongs to; scopes it to the `delivery:<id>` room. */
  delivery?: Types.ObjectId;
  /** Role of the sender at the time the message was sent. */
  senderRole?: string;
  /** User ids that have read the message. */
  readBy: string[];
  createdAt: Date;
}

const ChatMessageSchema = new mongoose.Schema(
  {
    content: { type: String, required: true },
    sender: { type: String },
    delivery: { type: Schema.Types.ObjectId, ref: 'Delivery' },
    senderRole: { type: String },
    readBy: { type: [String], default: [] },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);

ChatMessageSchema.index({ createdAt: -1 });
// Paginated per-delivery history, newest first.
ChatMessageSchema.index({ delivery: 1, createdAt: -1 });

const ChatMessage =
  (mongoose.models.ChatMessage as Model<IChatMessage>) ||
  mongoose.model<IChatMessage>('ChatMessage', ChatMessageSchema);

export default ChatMessage;
