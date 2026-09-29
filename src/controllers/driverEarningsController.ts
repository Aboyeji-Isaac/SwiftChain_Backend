import { Request, Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { driverEarningsService, EarningsGroupBy } from '../services/driverEarningsService';
import { UserRole } from '../interfaces/IUser';
import type { IUser } from '../interfaces/IUser';
import AppError from '../utils/AppError';
import { sendSuccess } from '../utils/responseWrapper';

const VALID_GROUP_BY: readonly EarningsGroupBy[] = ['day', 'week', 'month'];

/**
 * GET /api/v1/drivers/:id/earnings
 *
 * Returns a driver's earnings ledger, aggregated by day/week/month from
 * resolved (released) Escrow documents.
 *
 * A driver may only view their own earnings; an admin may view any
 * driver's.
 */
export const getDriverEarnings = async (
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const currentUser = (req as Request & { user?: IUser }).user;
    if (!currentUser) {
      throw new AppError('Authentication required.', StatusCodes.UNAUTHORIZED);
    }

    const { id: driverId } = req.params;
    driverEarningsService.assertValidDriverId(driverId);

    const isSelf = currentUser._id.toString() === driverId;
    const isAdmin = currentUser.role === UserRole.ADMIN;
    if (!isSelf && !isAdmin) {
      throw new AppError(
        'Access denied. You may only view your own earnings.',
        StatusCodes.FORBIDDEN,
      );
    }

    const groupByParam = req.query.groupBy as string | undefined;
    if (groupByParam && !VALID_GROUP_BY.includes(groupByParam as EarningsGroupBy)) {
      throw new AppError('groupBy must be one of: day, week, month.', StatusCodes.BAD_REQUEST);
    }

    const startDate = req.query.startDate ? new Date(req.query.startDate as string) : undefined;
    const endDate = req.query.endDate ? new Date(req.query.endDate as string) : undefined;

    if (startDate && Number.isNaN(startDate.getTime())) {
      throw new AppError('startDate must be a valid date.', StatusCodes.BAD_REQUEST);
    }
    if (endDate && Number.isNaN(endDate.getTime())) {
      throw new AppError('endDate must be a valid date.', StatusCodes.BAD_REQUEST);
    }

    const earnings = await driverEarningsService.getDriverEarnings({
      driverId,
      groupBy: (groupByParam as EarningsGroupBy) ?? 'day',
      startDate,
      endDate,
    });

    sendSuccess(res, earnings, 'Driver earnings retrieved successfully', StatusCodes.OK);
  } catch (error) {
    next(error);
  }
};
