import type { NextFunction, Request, Response } from 'express';
import { deliveryService } from '../services/delivery.service';
import { AppError } from '../utils/AppError';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

type AuthedRequest = Request & {
  user?: { _id?: unknown; id?: unknown; role?: unknown };
};

function parsePositiveInt(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * GET /api/v1/deliveries/:id/events — ordered milestone log for a delivery.
 *
 * Layering: Controller -> Service -> Repository. Authorization (participant
 * or admin) is enforced in the service so every caller gets the same rule.
 */
export const listDeliveryMilestones = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const user = (req as AuthedRequest).user;
    const userId = user?._id ?? user?.id;
    if (!user || !userId) {
      throw new AppError('Authentication required.', 401);
    }

    const page = parsePositiveInt(req.query.page, 1);
    const limit = Math.min(parsePositiveInt(req.query.limit, DEFAULT_LIMIT), MAX_LIMIT);

    const result = await deliveryService.listMilestones(
      req.params.id,
      { id: String(userId), role: String(user.role ?? '') },
      page,
      limit,
    );

    res.status(200).json({
      success: true,
      data: result.data,
      meta: {
        page: result.page,
        limit: result.limit,
        total: result.total,
        totalPages: result.totalPages,
      },
    });
  } catch (error) {
    next(error);
  }
};
