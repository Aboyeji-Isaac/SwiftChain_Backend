import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { deliveryHandlers } from '../indexer/deliveryHandlers';
import { sendSuccess, sendError } from '../utils/responseWrapper';
import logger from '../config/logger';

export class IndexerController {
  /**
   * Endpoint to process a delivery_created event.
   * Expects JSON body with { payload: "base64-encoded-xdr" }
   */
  public async handleDeliveryCreated(req: Request, res: Response): Promise<void> {
    try {
      const { payload } = req.body;

      if (!payload) {
        sendError(res, 'Missing payload in request body', StatusCodes.BAD_REQUEST);
        return;
      }

      const updatedDelivery = await deliveryHandlers.processDeliveryCreatedEvent(payload);

      sendSuccess(res, updatedDelivery, 'Delivery updated successfully', StatusCodes.OK);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Internal Server Error';
      logger.error(`IndexerController - handleDeliveryCreated error: ${message}`);
      sendError(res, message, StatusCodes.INTERNAL_SERVER_ERROR);
    }
  }
}

export const indexerController = new IndexerController();
