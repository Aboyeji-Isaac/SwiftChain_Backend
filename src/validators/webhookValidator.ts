import { z } from 'zod';
import { WebhookEvent } from '../models/WebhookSubscription';

export const registerWebhookSchema = z.object({
  url: z.url('url must be a valid URL.'),
  events: z
    .array(z.enum(WebhookEvent, { error: 'Each event must be a valid webhook event.' }))
    .min(1, 'At least one event must be selected.'),
  description: z.string().trim().max(500).optional(),
});

export const updateWebhookSchema = z
  .object({
    url: z.url('url must be a valid URL.').optional(),
    events: z
      .array(z.enum(WebhookEvent, { error: 'Each event must be a valid webhook event.' }))
      .min(1, 'At least one event must be selected.')
      .optional(),
    isActive: z.boolean().optional(),
    description: z.string().trim().max(500).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Request body must contain at least one field to update',
  });

export type RegisterWebhookInput = z.infer<typeof registerWebhookSchema>;
export type UpdateWebhookInput = z.infer<typeof updateWebhookSchema>;
