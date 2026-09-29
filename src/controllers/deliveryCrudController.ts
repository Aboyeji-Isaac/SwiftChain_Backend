import { Request, Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import crypto from 'crypto';
import mongoose from 'mongoose';
import Delivery, { DeliveryStatus } from '../models/Delivery';
import { sendSuccess, sendError } from '../utils/responseWrapper';

// POST /api/v1/deliveries
export const createDelivery = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { sender, recipient, packageDescription, weight, estimatedValue, notes } = req.body;

    if (!sender?.name || !sender?.contact || !sender?.address) {
      sendError(
        res,
        'sender.name, sender.contact, and sender.address are required',
        StatusCodes.BAD_REQUEST,
      );
      return;
    }
    if (!recipient?.name || !recipient?.contact || !recipient?.address) {
      sendError(
        res,
        'recipient.name, recipient.contact, and recipient.address are required',
        StatusCodes.BAD_REQUEST,
      );
      return;
    }
    if (!packageDescription) {
      sendError(res, 'packageDescription is required', StatusCodes.BAD_REQUEST);
      return;
    }

    const trackingId = `SWIFT-${crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`;

    const delivery = await Delivery.create({
      trackingId,
      sender,
      recipient,
      packageDescription,
      weight,
      estimatedValue,
      notes,
    });

    sendSuccess(res, delivery, 'Delivery created successfully', StatusCodes.CREATED);
  } catch (err) {
    next(err);
  }
};

// GET /api/v1/deliveries
export const getDeliveries = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 10));
    const skip = (page - 1) * limit;

    const filter: Record<string, unknown> = {};
    if (req.query.status) filter.status = req.query.status;

    const sortOrder = req.query.order === 'asc' ? 1 : -1;

    const [deliveries, total] = await Promise.all([
      Delivery.find(filter).sort({ createdAt: sortOrder }).skip(skip).limit(limit).lean(),
      Delivery.countDocuments(filter),
    ]);

    sendSuccess(
      res,
      {
        deliveries,
        pagination: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      },
      'Deliveries retrieved successfully',
      StatusCodes.OK,
    );
  } catch (err) {
    next(err);
  }
};

// GET /api/v1/deliveries/:id
export const getDeliveryById = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      sendError(res, 'Invalid delivery ID', StatusCodes.BAD_REQUEST);
      return;
    }

    const delivery = await Delivery.findById(id).lean();

    if (!delivery) {
      sendError(res, 'Delivery not found', StatusCodes.NOT_FOUND);
      return;
    }

    sendSuccess(res, delivery, 'Delivery retrieved successfully', StatusCodes.OK);
  } catch (err) {
    next(err);
  }
};

// PUT /api/v1/deliveries/:id/assign
export const assignDriver = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { id } = req.params;
    const { driverId } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      sendError(res, 'Invalid delivery ID', StatusCodes.BAD_REQUEST);
      return;
    }

    if (!driverId || typeof driverId !== 'string' || !driverId.trim()) {
      sendError(res, 'driverId is required', StatusCodes.BAD_REQUEST);
      return;
    }

    const delivery = await Delivery.findById(id);

    if (!delivery) {
      sendError(res, 'Delivery not found', StatusCodes.NOT_FOUND);
      return;
    }

    if (delivery.status !== DeliveryStatus.PENDING) {
      sendError(
        res,
        `Cannot assign driver to a delivery with status '${delivery.status}'`,
        StatusCodes.CONFLICT,
      );
      return;
    }

    delivery.driverId = driverId.trim();
    delivery.status = DeliveryStatus.ASSIGNED;
    await delivery.save();

    sendSuccess(res, delivery, 'Driver assigned successfully', StatusCodes.OK);
  } catch (err) {
    next(err);
  }
};
