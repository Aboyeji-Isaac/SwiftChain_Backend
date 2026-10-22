import { Request, Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import {
  escrowService,
  EscrowResolution,
  ExpiredEscrowAction,
  FLAGGED_ESCROW_FILTERS,
  FlaggedEscrowFilter,
} from '../services/escrow.service';
import { resolveQueryOptions } from '../middlewares/queryMiddleware';
import type { IUser } from '../interfaces/IUser';
import AppError from '../utils/AppError';
import { sendSuccess } from '../utils/responseWrapper';

const requireAdmin = (req: Request): IUser => {
  const adminUser = (req as Request & { user?: IUser }).user;
  if (!adminUser) {
    throw new AppError('Authentication required.', StatusCodes.UNAUTHORIZED);
  }
  return adminUser;
};

const requireReason = (reason: unknown): string => {
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new AppError('A non-empty "reason" is required.', StatusCodes.BAD_REQUEST);
  }
  return reason.trim();
};

// ─── GET /api/v1/admin/escrows/flagged ─────────────────────────────────────────

/**
 * Returns a paginated list of escrows flagged for admin review.
 *
 * Query params:
 *   - type   {disputed|expired|suspicious} Optional — all categories when omitted.
 *   - page, limit, sort — handled by the shared query middleware.
 */
export const listFlaggedEscrows = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { page, limit, sort } = resolveQueryOptions(req);
    const rawType = req.query.type;

    if (rawType !== undefined && !FLAGGED_ESCROW_FILTERS.includes(rawType as FlaggedEscrowFilter)) {
      throw new AppError(
        `"type" must be one of: ${FLAGGED_ESCROW_FILTERS.join(', ')}.`,
        StatusCodes.BAD_REQUEST,
      );
    }

    const result = await escrowService.getFlaggedEscrows({
      page,
      limit,
      sort,
      type: rawType as FlaggedEscrowFilter | undefined,
    });

    sendSuccess(res, result, 'Flagged escrows retrieved successfully', StatusCodes.OK);
  } catch (error) {
    next(error);
  }
};

// ─── PATCH /api/v1/admin/escrows/:id/resolve ───────────────────────────────────

interface ResolveEscrowBody {
  resolution?: unknown;
  reason?: unknown;
}

/**
 * Resolves a flagged escrow.
 *
 * Body:
 *   - resolution {release_to_driver|refund_to_payer|keep_locked} Required.
 *   - reason     {string} Required — recorded in the audit log.
 */
export const resolveFlaggedEscrow = async (
  req: Request<{ id: string }, unknown, ResolveEscrowBody>,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const adminUser = requireAdmin(req);
    const { resolution } = req.body;

    if (!Object.values(EscrowResolution).includes(resolution as EscrowResolution)) {
      throw new AppError(
        `"resolution" must be one of: ${Object.values(EscrowResolution).join(', ')}.`,
        StatusCodes.BAD_REQUEST,
      );
    }

    const escrow = await escrowService.resolveEscrow({
      escrowId: req.params.id,
      adminId: adminUser._id.toString(),
      resolution: resolution as EscrowResolution,
      reason: requireReason(req.body.reason),
    });

    sendSuccess(res, { escrow }, 'Escrow has been resolved successfully.', StatusCodes.OK);
  } catch (error) {
    next(error);
  }
};

// ─── POST /api/v1/admin/escrows/:id/expired/retry ──────────────────────────────

interface RetryExpiredEscrowBody {
  action?: unknown;
  reason?: unknown;
}

/**
 * Re-funds (re-locks) or fully cancels an expired escrow.
 *
 * Body:
 *   - action {refund|cancel} Required.
 *   - reason {string} Required — recorded in the audit log.
 */
export const retryExpiredEscrow = async (
  req: Request<{ id: string }, unknown, RetryExpiredEscrowBody>,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const adminUser = requireAdmin(req);
    const { action } = req.body;

    if (!Object.values(ExpiredEscrowAction).includes(action as ExpiredEscrowAction)) {
      throw new AppError(
        `"action" must be one of: ${Object.values(ExpiredEscrowAction).join(', ')}.`,
        StatusCodes.BAD_REQUEST,
      );
    }

    const escrow = await escrowService.retryExpiredEscrow({
      escrowId: req.params.id,
      adminId: adminUser._id.toString(),
      action: action as ExpiredEscrowAction,
      reason: requireReason(req.body.reason),
    });

    sendSuccess(res, { escrow }, 'Expired escrow updated successfully.', StatusCodes.OK);
  } catch (error) {
    next(error);
  }
};
