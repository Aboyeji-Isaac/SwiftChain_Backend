import { z } from 'zod';
import { DisputeReason, DisputeStatus } from '../models/Dispute';

export const createDisputeSchema = z.object({
  deliveryId: z.string({ error: 'deliveryId is required' }).trim().min(1, 'deliveryId is required'),
  raisedBy: z
    .string({ error: 'raisedBy is required' })
    .trim()
    .min(1, 'raisedBy is required')
    .optional(),
  reason: z.enum(DisputeReason, { error: 'A valid dispute reason is required' }),
  description: z
    .string({ error: 'description is required' })
    .trim()
    .min(10, 'description must be at least 10 characters')
    .max(2000, 'description must be at most 2000 characters'),
  evidenceUrls: z.array(z.url('Each evidence entry must be a valid URL')).max(10).optional(),
});

export const resolveDisputeSchema = z.object({
  status: z.enum(DisputeStatus, { error: 'A valid dispute status is required' }),
  resolutionNotes: z
    .string({ error: 'resolutionNotes is required' })
    .trim()
    .min(10, 'resolutionNotes must be at least 10 characters')
    .max(2000, 'resolutionNotes must be at most 2000 characters'),
  resolvedBy: z.string({ error: 'resolvedBy is required' }).trim().min(1).optional(),
});

export const addEvidenceSchema = z.object({
  evidenceUrls: z.array(z.url('Each evidence entry must be a valid URL')).min(1).max(10),
});

export const updateDisputeSchema = z
  .object({
    reason: z.enum(DisputeReason).optional(),
    description: z.string().trim().min(10).max(2000).optional(),
    evidenceUrls: z.array(z.url('Each evidence entry must be a valid URL')).max(10).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Request body must contain at least one field to update',
  });

export type CreateDisputeInput = z.infer<typeof createDisputeSchema>;
export type ResolveDisputeInput = z.infer<typeof resolveDisputeSchema>;
export type AddEvidenceInput = z.infer<typeof addEvidenceSchema>;
export type UpdateDisputeInput = z.infer<typeof updateDisputeSchema>;
export type DisputeFilter = {
  status?: DisputeStatus;
  raisedBy?: string;
  deliveryId?: string;
  reason?: DisputeReason;
  page?: number;
  limit?: number;
};
