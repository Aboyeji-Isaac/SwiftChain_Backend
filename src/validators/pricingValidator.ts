import { z } from 'zod';

const coordinates = z
  .object({
    lat: z.number().finite().min(-90).max(90),
    lng: z.number().finite().min(-180).max(180),
  })
  .strict();

export const estimateFeeSchema = z
  .object({
    pickup: coordinates,
    dropoff: coordinates,
  })
  .strict()
  .refine(({ pickup, dropoff }) => pickup.lat !== dropoff.lat || pickup.lng !== dropoff.lng, {
    message: 'Pickup and dropoff must differ',
    path: ['dropoff'],
  });
