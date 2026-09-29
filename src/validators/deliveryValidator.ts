import { z } from 'zod';
import { assetSchema, validateAsset } from '../services/currencyService';

const supportedAssetSchema = assetSchema.superRefine((asset, ctx) => {
  try {
    validateAsset(asset);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Unsupported asset or issuer' });
  }
});

// Location payloads consumed by DeliveryService.create (see
// src/services/delivery.service.ts CreateDeliveryInput).
const locationSchema = z
  .object({
    address: z.string().min(1).trim(),
    city: z.string().optional(),
    state: z.string().optional(),
    zipCode: z.string().optional(),
    instructions: z.string().optional(),
  })
  .passthrough();

const customerSchema = z
  .object({
    name: z.string().min(1).trim(),
    phone: z.string().min(1).trim(),
    email: z.string().email().optional(),
  })
  .passthrough();

const packageSchema = z
  .object({
    description: z.string().min(1).trim(),
    weight: z.number().positive().optional(),
    size: z.string().optional(),
    isFragile: z.boolean().optional(),
    requiresSignature: z.boolean().optional(),
  })
  .passthrough();

// Mirrors the fields DeliveryController.create actually passes to
// deliveryService.create — customer/pickup/dropoff/package + fees.
export const createDeliverySchema = z.object({
  trackingNumber: z.string().min(1).trim().optional(),
  customer: customerSchema,
  pickup: locationSchema,
  dropoff: locationSchema,
  package: packageSchema,
  deliveryFee: z.number().nonnegative().optional(),
  deliveryFeeAsset: supportedAssetSchema.optional(),
  escrowAmount: z.number().nonnegative().optional(),
  escrowAsset: supportedAssetSchema.optional(),
  notes: z.string().optional(),
});

export const updateDeliverySchema = z
  .object({
    trackingNumber: z.string().min(1).trim().optional(),
    customer: customerSchema.partial().optional(),
    pickup: locationSchema.partial().optional(),
    dropoff: locationSchema.partial().optional(),
    package: packageSchema.partial().optional(),
    deliveryFee: z.number().nonnegative().optional(),
    escrowAmount: z.number().nonnegative().optional(),
    notes: z.string().optional(),
    status: z.enum(['pending', 'assigned', 'in_transit', 'delivered', 'cancelled']).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'Request body must not be empty' });

export const updateDeliveryStatusSchema = z.object({
  status: z.enum(['pending', 'assigned', 'in_transit', 'delivered', 'cancelled']),
});

export const assignDriverSchema = z.object({
  driverId: z.string().min(1, 'driverId is required').trim(),
});
