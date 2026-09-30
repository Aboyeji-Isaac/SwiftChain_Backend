import type { NextFunction, Request, Response } from 'express';
import { deliveryService } from '../services/delivery.service';
import { DeliveryStatus } from '../models/Delivery';
import { AppError } from '../utils/AppError';
import { sendSuccess } from '../utils/responseWrapper';

/**
 * Status values from the retired legacy delivery model
 * (`src/models/deliveryModel.ts`, removed in issue #211).
 *
 * They are rejected explicitly — with a message that names the canonical
 * vocabulary — so a stale client sees *why* its request stopped working
 * instead of a generic validation error.
 */
const LEGACY_STATUSES: readonly string[] = ['picked_up', 'in_transit', 'delivered'];

/**
 * PUT /api/v1/deliveries/:id/status — transition a delivery's status.
 *
 * Issue #211: this endpoint used to implement a private, legacy state
 * machine (`pending -> assigned -> picked_up -> in_transit -> delivered`)
 * and wrote the result with a bare `save()`, putting deliveries into states
 * no other flow understood and corrupting the canonical records that escrow
 * release, driver assignment, and ETA rely on.
 *
 * The whole transition now runs through {@link deliveryService.updateStatus}
 * — the single state machine every delivery flow shares: same validation,
 * same atomic `DeliveryRepository.transitionStatus` write (concurrency-safe),
 * same proof-of-delivery gate on completion, same notifications and webhooks.
 *
 * Layering (non-negotiable): Controller -> Service -> Repository. This
 * handler performs no storage access of its own.
 */
export const updateDeliveryStatus = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { id } = req.params;
    const nextStatus = req.body?.status as unknown;

    if (typeof nextStatus === 'string' && LEGACY_STATUSES.includes(nextStatus)) {
      return next(
        new AppError(
          `Legacy status '${nextStatus}' is no longer accepted. Use the canonical ` +
            `DeliveryStatus vocabulary (${Object.values(DeliveryStatus).join(', ')}).`,
          400,
        ),
      );
    }

    if (
      typeof nextStatus !== 'string' ||
      !Object.values(DeliveryStatus).includes(nextStatus as DeliveryStatus)
    ) {
      return next(new AppError('Invalid status value', 400));
    }

    const delivery = await deliveryService.updateStatus(id, nextStatus as DeliveryStatus);

    sendSuccess(res, delivery, 'Delivery status updated successfully');
  } catch (error) {
    next(error as Error);
  }
};
