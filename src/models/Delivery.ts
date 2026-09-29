import mongoose, { Schema, Document } from 'mongoose';

export interface IDelivery extends Document {
  deliveryId: string;
  driverId: string;
  userId: string;
  sender: mongoose.Types.ObjectId;
  recipient: mongoose.Types.ObjectId;
  contractId?: string;
  metadata?: Record<string, unknown>;
  trackingNumber?: string;
  customer?: ICustomer;
  pickup?: ILocation;
  dropoff?: ILocation;
  package?: IPackage;
  deliveryFee?: number;
  escrowAmount?: number;
  notes?: string;
  pickupCoordinates: {
    lat: number;
    lng: number;
    address: string;
  };
  dropoffCoordinates: {
    lat: number;
    lng: number;
    address: string;
  };
  status: DeliveryStatus;
  distance?: number;
  estimatedDuration?: number;
  actualDuration?: number;
  proofOfDelivery?: IProofOfDelivery;
  isDeleted?: boolean;
  deletedAt?: Date | null;
  deletedBy?: string;
  createdAt: Date;
  updatedAt: Date;
  softDelete(userId?: string): Promise<this>;
  restore(): Promise<this>;
}

export enum DeliveryStatus {
  PENDING = 'pending',
  FUNDED = 'funded',
  ASSIGNED = 'assigned',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
}

export interface ICustomer {
  name: string;
  phone: string;
  email?: string;
}

export interface ILocation {
  address: string;
  city?: string;
  state?: string;
  zipCode?: string;
  instructions?: string;
}

export interface IPackage {
  description: string;
  weight: number;
  size?: string;
  isFragile?: boolean;
  requiresSignature?: boolean;
}

/** Image evidence a driver uploads to prove a delivery was completed. */
export interface IProofOfDelivery {
  /** Backend-specific object key (S3 key or local relative path). */
  storageKey: string;
  /** URL the image can be retrieved from. */
  imageUrl: string;
  storageDriver: string;
  mimeType: string;
  sizeBytes: number;
  /** User id (string) of the driver who uploaded the proof. */
  uploadedBy: string;
  uploadedAt: Date;
}

const DeliverySchema = new Schema<IDelivery>(
  {
    deliveryId: { type: String, unique: true, sparse: true },
    driverId: { type: String },
    userId: { type: String },
    sender: { type: Schema.Types.ObjectId, ref: 'User' },
    recipient: { type: Schema.Types.ObjectId, ref: 'User' },
    contractId: { type: String, trim: true },
    metadata: { type: Schema.Types.Mixed },
    trackingNumber: { type: String, unique: true, sparse: true },
    customer: { type: Schema.Types.Mixed },
    pickup: { type: Schema.Types.Mixed },
    dropoff: { type: Schema.Types.Mixed },
    package: { type: Schema.Types.Mixed },
    deliveryFee: { type: Number },
    escrowAmount: { type: Number },
    notes: { type: String },
    pickupCoordinates: {
      lat: { type: Number },
      lng: { type: Number },
      address: { type: String },
    },
    dropoffCoordinates: {
      lat: { type: Number },
      lng: { type: Number },
      address: { type: String },
    },
    status: {
      type: String,
      enum: Object.values(DeliveryStatus),
      default: DeliveryStatus.PENDING,
    },
    distance: { type: Number },
    estimatedDuration: { type: Number },
    actualDuration: { type: Number },
    proofOfDelivery: { type: Schema.Types.Mixed },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: String },
  },
  { timestamps: true, strict: false },
);

// ─── Indexes ────────────────────────────────────────────────────────────────
// trackingNumber/deliveryId already get unique indexes from `unique: true` above.

// GET /api/v1/deliveries: optional status filter, always sorted by createdAt desc
// (src/services/delivery.service.ts#list). A leading createdAt-only match still
// benefits unfiltered listing since it's an index prefix.
DeliverySchema.index({ status: 1, createdAt: -1 });

// GET /api/v1/deliveries?driver=...: optional driver filter, same sort
// (src/services/delivery.service.ts#list).
DeliverySchema.index({ driver: 1, createdAt: -1 });

// GET /api/v1/deliveries/archived: exact match on isDeleted, sorted by deletedAt desc
// (src/services/delivery.service.ts#listArchived).
DeliverySchema.index({ isDeleted: 1, deletedAt: -1 });

DeliverySchema.methods.softDelete = async function (
  this: IDelivery,
  userId?: string,
): Promise<IDelivery> {
  this.isDeleted = true;
  this.deletedAt = new Date();
  if (userId) {
    this.deletedBy = userId;
  }
  return this.save();
};

DeliverySchema.methods.restore = async function (this: IDelivery): Promise<IDelivery> {
  this.isDeleted = false;
  this.deletedAt = null;
  this.deletedBy = undefined;
  return this.save();
};

const Delivery = mongoose.model<IDelivery>('Delivery', DeliverySchema);

export default Delivery;
export { Delivery };
