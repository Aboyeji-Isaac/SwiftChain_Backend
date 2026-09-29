import { z } from 'zod';
import { validateAsset } from '../services/currencyService';

/**
 * Path params for `GET /api/v1/escrow/delivery/:id`.
 *
 * `id` may be a 24-character MongoDB ObjectId or the business `deliveryId`
 * key, so only generic length/charset constraints are enforced here; existence
 * is resolved in the service layer against the database.
 */
export const escrowByDeliveryParamsSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1, 'delivery id is required')
    .max(64, 'delivery id cannot exceed 64 characters')
    .regex(/^[A-Za-z0-9_-]+$/, 'delivery id contains invalid characters'),
});

export type EscrowByDeliveryParams = z.infer<typeof escrowByDeliveryParamsSchema>;

/**
 * Request body for `POST /api/v1/escrow/fund`.
 *
 * Represents the payload a client submits to record an on-chain
 * `escrow_funded` event against a delivery.
 */
export const fundEscrowBodySchema = z
  .object({
    deliveryId: z
      .string()
      .trim()
      .min(1, 'deliveryId is required')
      .regex(/^[a-fA-F0-9]{24}$/, 'deliveryId must be a valid MongoDB ObjectId'),

    contractId: z
      .string()
      .trim()
      .min(1, 'contractId is required')
      .max(128, 'contractId cannot exceed 128 characters'),

    transactionHash: z
      .string()
      .trim()
      .min(1, 'transactionHash is required')
      .max(256, 'transactionHash cannot exceed 256 characters'),

    amount: z
      .number({ error: 'amount must be a positive number' })
      .positive('amount must be greater than 0'),

    asset: z
      .string()
      .trim()
      .min(1, 'asset is required')
      .max(12, 'asset code cannot exceed 12 characters')
      .toUpperCase(),

    assetIssuer: z.string().trim().optional(),

    fundedBy: z.string().trim().max(128, 'fundedBy cannot exceed 128 characters').optional(),

    ledger: z
      .number({ error: 'ledger must be a non-negative integer' })
      .int('ledger must be an integer')
      .nonnegative('ledger must be non-negative')
      .optional(),
  })
  .superRefine((body, ctx) => {
    try {
      validateAsset({ code: body.asset, issuer: body.assetIssuer });
    } catch {
      ctx.addIssue({ code: 'custom', path: ['asset'], message: 'Unsupported asset or issuer' });
    }
  });

export type FundEscrowBody = z.infer<typeof fundEscrowBodySchema>;
