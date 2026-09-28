import { Request, Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { pricingService } from '../services/pricingService';
import { sendSuccess } from '../utils/responseWrapper';
import { z } from 'zod';
import { estimateFeeSchema } from '../validators/pricingValidator';

export class PricingController {
  async estimate(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const input = req.body as z.infer<typeof estimateFeeSchema>;
      const quote = await pricingService.estimate(input);
      sendSuccess(res, quote, 'Delivery fee estimated', StatusCodes.OK);
    } catch (error) {
      next(error);
    }
  }
}

export const pricingController = new PricingController();
