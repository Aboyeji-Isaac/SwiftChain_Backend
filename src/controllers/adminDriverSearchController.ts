import { Request, Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { resolveQueryOptions } from '../middlewares/queryMiddleware';
import { adminDriverSearchService } from '../services/adminDriverSearchService';
import ApiError from '../utils/ApiError';
import { sendSuccess } from '../utils/responseWrapper';

/**
 * GET /api/v1/admin/drivers
 *
 * Admin-only, paginated search across driver profiles and their public account
 * fields. Password hashes and other authentication-only fields are never
 * included in the repository projection or response DTO.
 */
export const searchAdminDrivers = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const rawSearch = req.query.search;
    if (rawSearch !== undefined && typeof rawSearch !== 'string') {
      throw ApiError.badRequest('search must be a single string value');
    }

    const result = await adminDriverSearchService.search(
      resolveQueryOptions(req),
      rawSearch as string | undefined,
    );

    sendSuccess(
      res,
      result,
      'Drivers retrieved successfully',
      StatusCodes.OK,
    );
  } catch (error) {
    next(error);
  }
};
