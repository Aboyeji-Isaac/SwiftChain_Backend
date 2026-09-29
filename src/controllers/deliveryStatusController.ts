import type { NextFunction, Request, Response } from 'express';
import { LocationUpdate } from '../models/LocationUpdate';
import mongoose from 'mongoose';
import { Delivery } from '../models/Delivery';
import type { DeliveryStatus } from '../models/Delivery';
import { HttpError } from '../utils/httpError';
import { sendSuccess } from '../utils/responseWrapper';

const allowedStatuses: readonly string[] = [
  'pending',
  'assigned',
  'picked_up',
  'in_transit',
  'delivered',
] as const;

const allowedTransitions: Record<string, readonly string[]> = {
  pending: ['assigned'],
  assigned: ['picked_up'],
  picked_up: ['in_transit'],
  in_transit: ['delivered'],
  delivered: [],
};

export const updateDeliveryStatus = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { id } = req.params;
    const nextStatus = req.body?.status as unknown;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(new HttpError(400, 'Invalid delivery ID'));
    }

    if (typeof nextStatus !== 'string' || !allowedStatuses.includes(nextStatus as DeliveryStatus)) {
      return next(new HttpError(400, 'Invalid status value'));
    }

    const delivery = await Delivery.findById(id);

    if (!delivery) {
      return next(new HttpError(404, 'Delivery not found'));
    }

    const currentStatus = String(delivery.status);
    const isAllowed = allowedTransitions[currentStatus]?.includes(nextStatus as string) ?? false;

    if (!isAllowed) {
      return next(new HttpError(400, 'Invalid status transition'));
    }

    // Fetch latest driver location for this delivery (only needed for the
    // final 'delivered' transition, where proximity to the drop-off matters).
    if (nextStatus === 'delivered') {
      const latestLocation = await LocationUpdate.findOne({
        driverId: delivery.driverId,
        deliveryId: delivery._id,
      })
        .sort({ capturedAt: -1 })
        .lean();

      const haversine = (lat1: number, lng1: number, lat2: number, lng2: number): number => {
        const toRad = (deg: number) => (deg * Math.PI) / 180;
        const R = 6371; // Earth radius in km
        const dLat = toRad(lat2 - lat1);
        const dLng = toRad(lng2 - lng1);
        const a =
          Math.sin(dLat / 2) ** 2 +
          Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(a));
      };

      const ACCEPTABLE_RADIUS_KM = 0.2; // 200 meters

      if (!latestLocation) {
        return next(new HttpError(400, 'No recent driver location available for validation'));
      }
      if (!delivery.dropoffCoordinates) {
        return next(new HttpError(400, 'Delivery has no drop-off coordinates to validate against'));
      }

      const distanceKm = haversine(
        latestLocation.coordinates.lat,
        latestLocation.coordinates.lng,
        delivery.dropoffCoordinates.lat,
        delivery.dropoffCoordinates.lng,
      );
      if (distanceKm > ACCEPTABLE_RADIUS_KM) {
        return next(
          new HttpError(
            400,
            `Driver is too far from drop-off location (distance: ${distanceKm.toFixed(2)} km)`,
          ),
        );
      }
    }

    delivery.status = nextStatus as DeliveryStatus;
    await delivery.save();

    sendSuccess(res, delivery, 'Delivery status updated successfully');
  } catch (error) {
    next(error as Error);
  }
};
