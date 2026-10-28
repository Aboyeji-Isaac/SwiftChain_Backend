import mongoose, { Schema } from 'mongoose';
import bcrypt from 'bcryptjs';
import env from '../config/env';
import { IUser, UserRole, UserStatus } from '../interfaces/IUser';

const userSchema = new Schema<IUser>(
  {
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email address'],
    },
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: [8, 'Password must be at least 8 characters'],
      select: false,
    },
    firstName: {
      type: String,
      required: [true, 'First name is required'],
      trim: true,
      maxlength: [50, 'First name cannot exceed 50 characters'],
    },
    lastName: {
      type: String,
      required: [true, 'Last name is required'],
      trim: true,
      maxlength: [50, 'Last name cannot exceed 50 characters'],
    },
    role: {
      type: String,
      enum: Object.values(UserRole),
      default: UserRole.USER,
    },
    status: {
      type: String,
      enum: Object.values(UserStatus),
      default: UserStatus.ACTIVE,
    },
    suspendedReason: {
      type: String,
    },
    suspendedAt: {
      type: Date,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    walletAddress: {
      type: String,
      trim: true,
      unique: true,
      sparse: true,
      match: [/^G[A-Z2-7]{55}$/, 'Please provide a valid Stellar public key'],
    },
    profilePicture: {
      type: String,
      trim: true,
    },
    profilePictureKey: {
      type: String,
      trim: true,
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
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret): Record<string, unknown> {
        ret.id = ret._id;
        delete ret._id;
        delete ret.__v;
        delete ret.password;
        return ret;
      },
    },
  },
);

// Hash password before saving
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) {
    return next();
  }

  try {
    const salt = await bcrypt.genSalt(env.BCRYPT_ROUNDS);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error as Error);
  }
});

// Instance method to compare passwords
userSchema.methods.comparePassword = async function (candidatePassword: string): Promise<boolean> {
  return bcrypt.compare(candidatePassword, this.password);
};

// Soft delete instance method
userSchema.methods.softDelete = async function (userId?: string): Promise<IUser> {
  this.isDeleted = true;
  this.deletedAt = new Date();
  if (userId) {
    this.deletedBy = userId;
  }
  return this.save();
};

// Restore instance method
userSchema.methods.restore = async function (): Promise<IUser> {
  this.isDeleted = false;
  this.deletedAt = null;
  this.deletedBy = undefined;
  return this.save();
};

// Index for efficient email lookups (login, registration duplicate checks).
userSchema.index({ email: 1 });

// Every authenticated request checks role (src/middleware/auth.ts#authorize,
// src/middleware/requireRole.ts) and account status (src/middleware/authenticate.ts
// blocks suspended/banned accounts); this compound index supports filtering
// users by role and/or status, e.g. an admin listing all suspended drivers.
userSchema.index({ role: 1, status: 1 });

// Compound index for filtering active/non-deleted users
userSchema.index({ isDeleted: 1, status: 1 });

const User = mongoose.model<IUser>('User', userSchema);

export default User;
