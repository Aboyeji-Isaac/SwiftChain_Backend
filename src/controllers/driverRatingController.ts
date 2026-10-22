import { Request, Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { driverRatingService } from '../services/driverRatingService';
import { UserRole } from '../interfaces/IUser';
import type { IUser } from '../interfaces/IUser';
import AppError from '../utils/AppError';
import { sendSuccess } from '../utils/responseWrapper';

/**
 * DriverRatingController — HTTP surface for the driver rating & penalty system.
 *
 * Thin by design: it validates the request boundary and delegates every
 * computation to {@link driverRatingService}.
 */
class DriverRatingController {
  /**
   * GET /api/v1/drivers/:driverId/rating
   *
   * Return a driver's stored rating, penalty state and delivery counters.
   * A driver may only read their own rating; an admin may read any driver's.
   */
  async getDriverRating(
    req: Request<{ driverId: string }>,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const currentUser = (req as Request & { user?: IUser }).user;
      if (!currentUser) {
        throw new AppError('Authentication required.', StatusCodes.UNAUTHORIZED);
      }

      const { driverId } = req.params;
      driverRatingService.assertValidDriverId(driverId);

      const isSelf = currentUser._id.toString() === driverId;
      const isAdmin = currentUser.role === UserRole.ADMIN;
      if (!isSelf && !isAdmin) {
        throw new AppError(
          'Access denied. You may only view your own rating.',
          StatusCodes.FORBIDDEN,
        );
      }

      const rating = await driverRatingService.getDriverRating(driverId);

      sendSuccess(res, { rating }, 'Driver rating retrieved successfully', StatusCodes.OK);
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/v1/drivers/:driverId/rating/recalculate
   *
   * Recompute one driver's rating from their delivery history and apply a
   * suspension when the score is extremely low. Admin only.
   */
  async recalculateDriverRating(
    req: Request<{ driverId: string }>,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const rating = await driverRatingService.evaluateDriverRating(req.params.driverId);

      sendSuccess(
        res,
        { rating },
        rating.penaltyApplied
          ? 'Driver rating recalculated and a penalty applied.'
          : 'Driver rating recalculated successfully.',
        StatusCodes.OK,
      );
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/v1/drivers/rating/recalculate
   *
   * Recalculate every driver's rating and lift expired suspensions. Admin only.
   */
  async recalculateAllRatings(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await driverRatingService.recalculateAllDriverRatings();

      sendSuccess(res, { result }, 'Driver ratings recalculated successfully', StatusCodes.OK);
    } catch (error) {
      next(error);
    }
  }
}

export const driverRatingController = new DriverRatingController();
export default driverRatingController;
