import { Request, Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { escrowService } from '../services/escrow.service';
import type { IUser } from '../interfaces/IUser';
import AppError from '../utils/AppError';
import { sendSuccess } from '../utils/responseWrapper';

// ─── GET /api/v1/admin/escrows/flagged ─────────────────────────────────────────

/**
 * Returns a paginated list of escrows flagged as expired for admin review.
 *
 * Query params:
 *   - page   {number} Optional — defaults to 1.
 *   - limit  {number} Optional — defaults to 20, capped at 100.
 */
export const listFlaggedEscrows = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const page = req.query.page ? parseInt(req.query.page as string, 10) : undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;

    if (page !== undefined && (!Number.isInteger(page) || page < 1)) {
      throw new AppError('"page" must be a positive integer.', StatusCodes.BAD_REQUEST);
    }

    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new AppError('"limit" must be a positive integer.', StatusCodes.BAD_REQUEST);
    }

    const result = await escrowService.getFlaggedEscrows({ page, limit });

    sendSuccess(res, result, 'Flagged escrows retrieved successfully', StatusCodes.OK);
  } catch (error) {
    next(error);
  }
};

// ─── PATCH /api/v1/admin/escrows/:id/resolve ───────────────────────────────────

interface ResolveEscrowBody {
  notes?: unknown;
}

/**
 * Marks a flagged (expired) escrow as resolved.
 *
 * Body:
 *   - notes {string} Required — audit trail description of the resolution.
 */
export const resolveFlaggedEscrow = async (
  req: Request<{ id: string }, unknown, ResolveEscrowBody>,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const adminUser = (req as Request & { user?: IUser }).user;

    if (!adminUser) {
      throw new AppError('Authentication required.', StatusCodes.UNAUTHORIZED);
    }

    const { notes } = req.body;

    if (!notes || typeof notes !== 'string' || notes.trim().length === 0) {
      throw new AppError(
        'Resolution notes are required to resolve a flagged escrow.',
        StatusCodes.BAD_REQUEST,
      );
    }

    const escrow = await escrowService.resolveEscrow({
      escrowId: req.params.id,
      adminId: adminUser._id.toString(),
      notes: notes.trim(),
    });

    sendSuccess(res, { escrow }, 'Escrow has been resolved successfully.', StatusCodes.OK);
  } catch (error) {
    next(error);
  }
};
