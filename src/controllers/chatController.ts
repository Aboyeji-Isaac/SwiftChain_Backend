import { Request, Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { Types } from 'mongoose';
import { chatMessageService } from '../sockets/chatMessage.service';
import type { IUser } from '../interfaces/IUser';
import AppError from '../utils/AppError';
import { sendSuccess } from '../utils/responseWrapper';

const parsePositiveInt = (value: unknown, name: string): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new AppError(`"${name}" must be a positive integer.`, StatusCodes.BAD_REQUEST);
  }
  return parsed;
};

// ─── GET /api/v1/deliveries/:id/messages ───────────────────────────────────────

/** Paginated chat history for a delivery, restricted to its participants and admins. */
export const getDeliveryMessages = async (
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const user = (req as Request & { user?: IUser }).user;
    if (!user) {
      throw new AppError('Authentication required.', StatusCodes.UNAUTHORIZED);
    }

    const deliveryId = req.params.id;
    if (!Types.ObjectId.isValid(deliveryId)) {
      throw new AppError('Invalid delivery ID format.', StatusCodes.BAD_REQUEST);
    }

    const page = parsePositiveInt(req.query.page, 'page');
    const limit = parsePositiveInt(req.query.limit, 'limit');

    const allowed = await chatMessageService.canAccessDelivery(user._id.toString(), deliveryId);
    if (!allowed) {
      throw new AppError('Not a participant of this delivery.', StatusCodes.FORBIDDEN);
    }

    const history = await chatMessageService.getDeliveryHistory(deliveryId, page, limit);
    sendSuccess(res, history, 'Delivery messages retrieved successfully', StatusCodes.OK);
  } catch (error) {
    next(error);
  }
};
