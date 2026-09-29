import { Request, Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import {
  suspendUser as suspendUserService,
  getAdminDisputes as getAdminDisputesService,
} from '../services/adminService';
import type { IUser } from '../interfaces/IUser';
import AppError from '../utils/AppError';
import { sendSuccess } from '../utils/responseWrapper';

// ─── Request body type ─────────────────────────────────────────────────────────

interface SuspendUserBody {
  reason?: unknown;
  ban?: unknown;
}

// ─── Controller ────────────────────────────────────────────────────────────────

/**
 * PUT /api/v1/admin/users/:id/suspend
 *
 * Suspends (or permanently bans) a user or driver account.
 * The route is protected by `authenticate` + `requireRole(UserRole.ADMIN)`.
 *
 * Body:
 *   - reason  {string}  Required — audit trail description.
 *   - ban     {boolean} Optional — true applies a permanent ban instead of suspension.
 *
 * Responds:
 *   200 — success, returns the updated user document.
 */
export const suspendUser = async (
  req: Request<{ id: string }, unknown, SuspendUserBody>,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const adminUser = (req as Request & { user?: IUser }).user;

    if (!adminUser) {
      throw new AppError('Authentication required.', StatusCodes.UNAUTHORIZED);
    }

    const { id: targetUserId } = req.params;
    const { reason, ban } = req.body;

    if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
      throw new AppError('A reason is required to suspend or ban a user.', StatusCodes.BAD_REQUEST);
    }

    if (ban !== undefined && typeof ban !== 'boolean') {
      throw new AppError('"ban" must be a boolean value.', StatusCodes.BAD_REQUEST);
    }

    const { user, action } = await suspendUserService({
      targetUserId,
      adminId: adminUser._id.toString(),
      reason: reason.trim(),
      ban: ban === true,
    });

    sendSuccess(res, { user }, `User has been ${action} successfully.`, StatusCodes.OK);
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/v1/admin/disputes
 *
 * Retrieves a paginated list of disputes for the admin dashboard.
 * Supports pagination (`page`, `limit`) and filtering by `status`.
 * Protected by `authenticate` + `requireRole(UserRole.ADMIN)`.
 */
export const getDisputes = async (
  req: Request<unknown, unknown, unknown, { page?: string; limit?: string; status?: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const adminUser = (req as Request & { user?: IUser }).user;

    if (!adminUser) {
      throw new AppError('Authentication required.', StatusCodes.UNAUTHORIZED);
    }

    const { page: rawPage, limit: rawLimit, status } = req.query;

    let page = 1;
    let limit = 10;

    if (rawPage !== undefined && rawPage !== '') {
      page = Number(rawPage);
      if (!Number.isInteger(page) || page < 1) {
        throw new AppError('Page must be a positive integer.', StatusCodes.BAD_REQUEST);
      }
    }

    if (rawLimit !== undefined && rawLimit !== '') {
      limit = Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1) {
        throw new AppError('Limit must be a positive integer.', StatusCodes.BAD_REQUEST);
      }
    }

    const result = await getAdminDisputesService({
      page,
      limit,
      status: status !== undefined ? String(status) : undefined,
    });

    sendSuccess(
      res,
      { disputes: result.disputes, pagination: result.pagination },
      'Disputes retrieved successfully',
      StatusCodes.OK,
    );
  } catch (error) {
    next(error);
  }
};
