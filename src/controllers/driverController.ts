import { Request, Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { driverService } from '../services/driverService';
import type { IUser } from '../interfaces/IUser';
import AppError from '../utils/AppError';
import { sendSuccess } from '../utils/responseWrapper';

interface SetVehicleDetailsBody {
  make?: unknown;
  model?: unknown;
  year?: unknown;
  plateNumber?: unknown;
  capacityKg?: unknown;
}

class DriverController {
  /**
   * GET /api/v1/drivers/leaderboard
   *
   * Returns drivers ranked by reputation points, highest first.
   * Supports ?page and ?limit query params.
   */
  async getLeaderboard(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));

      const result = await driverService.getLeaderboard(page, limit);

      sendSuccess(res, result, 'Leaderboard retrieved successfully', StatusCodes.OK);
    } catch (err) {
      next(err);
    }
  }

  /**
   * PATCH /api/v1/drivers/me/vehicle
   *
   * Creates or updates the authenticated driver's vehicle details.
   */
  async setVehicleDetails(
    req: Request<unknown, unknown, SetVehicleDetailsBody>,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const driver = (req as Request & { user?: IUser }).user;
      if (!driver) {
        throw new AppError('Authentication required.', StatusCodes.UNAUTHORIZED);
      }

      const { make, model, year, plateNumber, capacityKg } = req.body;

      if (!make || typeof make !== 'string') {
        throw new AppError('make is required.', StatusCodes.BAD_REQUEST);
      }
      if (!model || typeof model !== 'string') {
        throw new AppError('model is required.', StatusCodes.BAD_REQUEST);
      }
      if (!plateNumber || typeof plateNumber !== 'string') {
        throw new AppError('plateNumber is required.', StatusCodes.BAD_REQUEST);
      }
      if (year !== undefined && typeof year !== 'number') {
        throw new AppError('year must be a number.', StatusCodes.BAD_REQUEST);
      }
      if (capacityKg !== undefined && typeof capacityKg !== 'number') {
        throw new AppError('capacityKg must be a number.', StatusCodes.BAD_REQUEST);
      }

      const profile = await driverService.setVehicleDetails(driver._id.toString(), {
        make,
        model,
        plateNumber,
        year: year as number | undefined,
        capacityKg: capacityKg as number | undefined,
      });

      sendSuccess(res, { profile }, 'Vehicle details updated successfully.', StatusCodes.OK);
    } catch (err) {
      next(err);
    }
  }
}

export const driverController = new DriverController();
