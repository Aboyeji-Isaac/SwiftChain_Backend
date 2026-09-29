import mongoose, { Schema } from 'mongoose';
import { IDriverProfile, ReputationTier } from '../interfaces/IDriverProfile';
import { nowUTC } from '../utils/dateUtils';

const vehicleDetailsSchema = new Schema(
  {
    make: {
      type: String,
      required: [true, 'Vehicle make is required'],
      trim: true,
    },
    model: {
      type: String,
      required: [true, 'Vehicle model is required'],
      trim: true,
    },
    year: {
      type: Number,
      min: [1980, 'Vehicle year must be 1980 or later'],
      max: [nowUTC().getUTCFullYear() + 1, 'Vehicle year cannot be in the future'],
    },
    plateNumber: {
      type: String,
      required: [true, 'Vehicle plate number is required'],
      trim: true,
      uppercase: true,
    },
    capacityKg: {
      type: Number,
      min: [0, 'capacityKg cannot be negative'],
    },
  },
  { _id: false },
);

const driverProfileSchema = new Schema<IDriverProfile>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'userId is required'],
      unique: true,
    },
    reputationPoints: {
      type: Number,
      default: 0,
      min: [0, 'reputationPoints cannot be negative'],
    },
    tier: {
      type: String,
      enum: Object.values(ReputationTier),
      default: ReputationTier.BRONZE,
    },
    totalDeliveries: {
      type: Number,
      default: 0,
      min: 0,
    },
    completedDeliveries: {
      type: Number,
      default: 0,
      min: 0,
    },
    vehicleDetails: {
      type: vehicleDetailsSchema,
      required: false,
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
    deletedBy: {
      type: String,
    },
  },
  { timestamps: true },
);

driverProfileSchema.methods.softDelete = async function (userId?: string): Promise<IDriverProfile> {
  this.isDeleted = true;
  this.deletedAt = new Date();
  if (userId) {
    this.deletedBy = userId;
  }
  return this.save();
};

driverProfileSchema.methods.restore = async function (): Promise<IDriverProfile> {
  this.isDeleted = false;
  this.deletedAt = null;
  this.deletedBy = undefined;
  return this.save();
};

// Index for leaderboard queries: descending reputation points
driverProfileSchema.index({ reputationPoints: -1 });

// Compound index for filtering by user and deletion status
driverProfileSchema.index({ userId: 1, isDeleted: 1 });

const DriverProfile = mongoose.model<IDriverProfile>('DriverProfile', driverProfileSchema);

export default DriverProfile;
