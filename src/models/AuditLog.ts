import mongoose, { Document, Schema } from 'mongoose';

export interface IAuditLog extends Document {
  action: string;
  actor?: mongoose.Types.ObjectId | null;
  targetType?: string;
  targetId?: mongoose.Types.ObjectId | null;
  description?: string;
  meta?: Record<string, any> | null;
  createdAt: Date;
}

const AuditLogSchema: Schema = new Schema(
  {
    action: { type: String, required: true },
    actor: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    targetType: { type: String, default: null },
    targetId: { type: Schema.Types.ObjectId, default: null },
    description: { type: String, default: null },
    meta: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export default mongoose.model<IAuditLog>('AuditLog', AuditLogSchema);
