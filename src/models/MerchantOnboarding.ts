/**
 * MerchantOnboarding.ts
 *
 * One self-serve merchant onboarding attempt, from registered intent to an
 * activated merchant.
 *
 * Nothing durable is created when a merchant first registers: the business
 * metadata, treasury address and contact details wait here, together with a
 * wallet-ownership challenge, until the merchant proves they control the
 * treasury wallet by signing that challenge. Only then are the Fleet, the
 * enterprise owner account and the default webhook subscription created, and
 * their ids recorded back on this document.
 *
 * Status lifecycle:
 *   pending_wallet ──(valid signature)──► activating ──► completed
 *         ▲                                   │
 *         └────────(activation failed)────────┘
 *
 * `activating` is a short-lived claim so two concurrent proofs for the same
 * onboarding cannot both create a merchant.
 */

import mongoose, { Schema, Document, Types } from 'mongoose';

export enum OnboardingStatus {
  PENDING_WALLET = 'pending_wallet',
  ACTIVATING = 'activating',
  COMPLETED = 'completed',
}

export interface IOnboardingBusinessMetadata {
  companyName: string;
  industry?: string;
  registrationNumber?: string;
  vatNumber?: string;
  address?: {
    street?: string;
    city?: string;
    country?: string;
    postalCode?: string;
  };
  contactEmail: string;
  contactPhone?: string;
  website?: string;
}

export interface IOnboardingContact {
  firstName: string;
  lastName: string;
  /** Becomes the owner account's login email. */
  email: string;
  phone?: string;
}

export interface IOnboardingChallenge {
  /** Exact text the treasury wallet must sign. */
  message: string;
  expiresAt: Date;
}

export interface IMerchantOnboarding extends Document {
  status: OnboardingStatus;
  fleetName: string;
  treasuryAddress: string;
  businessMetadata: IOnboardingBusinessMetadata;
  contact: IOnboardingContact;
  /** Endpoint for the default webhook subscription created on activation. */
  webhookUrl: string;
  challenge: IOnboardingChallenge;
  /** Rejected wallet proofs; the onboarding locks once this reaches the configured limit. */
  failedProofAttempts: number;
  ownerId?: Types.ObjectId | null;
  fleetId?: Types.ObjectId | null;
  webhookId?: Types.ObjectId | null;
  completedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const MerchantOnboardingSchema = new Schema<IMerchantOnboarding>(
  {
    status: {
      type: String,
      enum: Object.values(OnboardingStatus),
      default: OnboardingStatus.PENDING_WALLET,
      required: true,
      index: true,
    },
    fleetName: { type: String, required: true, trim: true, maxlength: 100 },
    treasuryAddress: { type: String, required: true, trim: true, index: true },
    businessMetadata: {
      companyName: { type: String, required: true, trim: true },
      industry: { type: String, trim: true },
      registrationNumber: { type: String, trim: true },
      vatNumber: { type: String, trim: true },
      address: {
        street: { type: String, trim: true },
        city: { type: String, trim: true },
        country: { type: String, trim: true },
        postalCode: { type: String, trim: true },
      },
      contactEmail: { type: String, required: true, trim: true, lowercase: true },
      contactPhone: { type: String, trim: true },
      website: { type: String, trim: true },
    },
    contact: {
      firstName: { type: String, required: true, trim: true },
      lastName: { type: String, required: true, trim: true },
      email: { type: String, required: true, trim: true, lowercase: true, index: true },
      phone: { type: String, trim: true },
    },
    webhookUrl: { type: String, required: true, trim: true },
    challenge: {
      message: { type: String, required: true },
      expiresAt: { type: Date, required: true },
    },
    failedProofAttempts: { type: Number, default: 0, min: 0 },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    fleetId: { type: Schema.Types.ObjectId, ref: 'Fleet', default: null },
    webhookId: { type: Schema.Types.ObjectId, ref: 'WebhookSubscription', default: null },
    completedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc, ret: Record<string, unknown>) => {
        ret.id = ret._id;
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  },
);

export const MerchantOnboarding = mongoose.model<IMerchantOnboarding>(
  'MerchantOnboarding',
  MerchantOnboardingSchema,
);

export default MerchantOnboarding;
