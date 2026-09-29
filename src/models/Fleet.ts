import mongoose, { Schema } from 'mongoose';
import { IFleet } from '../interfaces/IFleet';

const fleetSchema = new Schema<IFleet>(
  {
    name: {
      type: String,
      required: [true, 'Fleet name is required'],
      trim: true,
      minlength: [2, 'Fleet name must be at least 2 characters'],
      maxlength: [100, 'Fleet name cannot exceed 100 characters'],
    },
    treasuryAddress: {
      type: String,
      required: [true, 'Treasury address is required'],
      trim: true,
      validate: {
        validator: (v: string) => /^G[A-Z0-9]{55}$/.test(v),
        message: 'Invalid Stellar address format. Must start with G and be 56 characters long.',
      },
    },
    ownerId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'ownerId is required'],
    },
    members: [
      {
        userId: {
          type: Schema.Types.ObjectId,
          ref: 'User',
          required: true,
        },
        role: {
          type: String,
          enum: ['admin', 'driver', 'viewer'],
          default: 'driver',
        },
        joinedAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    businessMetadata: {
      companyName: {
        type: String,
        required: [true, 'Company name is required'],
        trim: true,
      },
      industry: {
        type: String,
        trim: true,
      },
      registrationNumber: {
        type: String,
        trim: true,
      },
      vatNumber: {
        type: String,
        trim: true,
      },
      address: {
        street: { type: String, trim: true },
        city: { type: String, trim: true },
        country: { type: String, trim: true },
        postalCode: { type: String, trim: true },
      },
      contactEmail: {
        type: String,
        required: [true, 'Contact email is required'],
        trim: true,
        lowercase: true,
        match: [/^\S+@\S+\.\S+$/, 'Invalid email format'],
      },
      contactPhone: {
        type: String,
        trim: true,
      },
      website: {
        type: String,
        trim: true,
      },
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    // Keep drivers array for backward compatibility if needed
    drivers: {
      type: [{ type: Schema.Types.ObjectId, ref: 'User' }],
      default: [],
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// Indexes for performance
fleetSchema.index({ ownerId: 1 });
fleetSchema.index({ 'members.userId': 1 });
fleetSchema.index({ treasuryAddress: 1 }, { unique: true });

// Pre-save middleware to ensure owner is also in members
fleetSchema.pre('save', function (next) {
  if (this.isNew) {
    const ownerExists = this.members.some(
      (member) => member.userId.toString() === this.ownerId.toString(),
    );
    if (!ownerExists) {
      this.members.push({
        userId: this.ownerId,
        role: 'admin',
        joinedAt: new Date(),
      });
    }
  }
  next();
});

// Virtual to get driver IDs from members
fleetSchema.virtual('driverIds').get(function () {
  return this.members.filter((m) => m.role === 'driver' || m.role === 'admin').map((m) => m.userId);
});

const Fleet = mongoose.model<IFleet>('Fleet', fleetSchema);

export default Fleet;
