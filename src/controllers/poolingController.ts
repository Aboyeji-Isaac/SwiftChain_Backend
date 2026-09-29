import { Request, Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { poolingService } from '../services/poolingService';
import { sendSuccess } from '../utils/responseWrapper';

/**
 * POST /api/v1/pooling/create
 * Create proximity-based delivery pools (does not assign yet).
 */
export const createPools = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const pools = await poolingService.createPools(req.body);
    sendSuccess(res, { pools, count: pools.length }, 'Pools created successfully');
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/v1/pooling/assign
 * Create pools and assign each multi-delivery pool to the nearest driver.
 */
export const poolAndAssign = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const result = await poolingService.poolAndAssign(req.body);
    sendSuccess(
      res,
      result,
      `Created ${result.poolsCreated} pools, assigned ${result.poolsAssigned}`,
      StatusCodes.OK,
    );
  } catch (error) {
    next(error);
  }
};