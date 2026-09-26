import { Request, Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { proofOfDeliveryService } from '../services/proofOfDeliveryService';
import type { IUser } from '../interfaces/IUser';
import AppError from '../utils/AppError';
import { sendSuccess } from '../utils/responseWrapper';

/**
 * POST /api/v1/deliveries/:id/proof-of-delivery
 *
 * Uploads the image a driver captures as evidence of completion. This does
 * not itself mark the delivery completed — it unblocks the completion and
 * escrow-release transitions, which each check for this record separately.
 */
export const uploadProofOfDeliveryHandler = async (
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const currentUser = (req as Request & { user?: IUser }).user;
    if (!currentUser) {
      throw new AppError('Authentication required.', StatusCodes.UNAUTHORIZED);
    }

    const file = (req as Request & { file?: Express.Multer.File }).file;
    if (!file) {
      throw new AppError('A "file" is required.', StatusCodes.BAD_REQUEST);
    }

    const delivery = await proofOfDeliveryService.uploadProofOfDelivery({
      deliveryId: req.params.id,
      uploadedBy: currentUser._id.toString(),
      originalName: file.originalname,
      mimeType: file.mimetype,
      buffer: file.buffer,
      sizeBytes: file.size,
    });

    sendSuccess(res, { delivery }, 'Proof of delivery uploaded successfully.', StatusCodes.CREATED);
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/v1/deliveries/:id/proof-of-delivery
 *
 * Returns the proof-of-delivery record for a delivery, or `null` if none
 * has been uploaded yet.
 */
export const getProofOfDeliveryHandler = async (
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const proofOfDelivery = await proofOfDeliveryService.getProofOfDelivery(req.params.id);
    sendSuccess(
      res,
      { proofOfDelivery },
      'Proof of delivery retrieved successfully',
      StatusCodes.OK,
    );
  } catch (error) {
    next(error);
  }
};
