import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { deliveryService } from '../services/deliveryService';
import { sendSuccess, sendError } from '../utils/responseWrapper';

class DeliveryController {
  async getDeliveryETA(req: Request, res: Response): Promise<void> {
    const { id } = req.params;

    if (!id) {
      sendError(res, 'Delivery ID is required', StatusCodes.BAD_REQUEST);
      return;
    }

    try {
      const result = await deliveryService.calculateDeliveryETA({ deliveryId: id });
      sendSuccess(res, result, 'ETA calculated successfully', StatusCodes.OK);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const statusCode = errorMessage.includes('not found')
        ? StatusCodes.NOT_FOUND
        : StatusCodes.INTERNAL_SERVER_ERROR;
      sendError(res, errorMessage || 'Failed to calculate ETA', statusCode);
    }
  }
}

export const deliveryController = new DeliveryController();
