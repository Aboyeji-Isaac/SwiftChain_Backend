import { Request, Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import deliveryChatService from '../services/deliveryChatService';
import type { IUser } from '../interfaces/IUser';
import AppError from '../utils/AppError';
import { sendSuccess } from '../utils/responseWrapper';

function requireUser(req: Request): IUser {
  const user = (req as Request & { user?: IUser }).user;
  if (!user) {
    throw new AppError('Authentication required.', StatusCodes.UNAUTHORIZED);
  }
  return user;
}

/**
 * GET /api/v1/deliveries/:id/messages
 * Paginated chat history for a delivery (participants only).
 */
export const getDeliveryMessages = async (
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const user = requireUser(req);
    const { id } = req.params;

    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(Math.max(1, parseInt(req.query.limit as string, 10) || 20), 100);

    const result = await deliveryChatService.getDeliveryMessages(
      id,
      user._id.toString(),
      user.role,
      page,
      limit,
    );

    sendSuccess(res, result, 'Messages retrieved successfully', StatusCodes.OK);
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/v1/deliveries/:id/messages/unread
 * Get unread messages count for the requesting user on a delivery.
 */
export const getUnreadCount = async (
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const user = requireUser(req);
    const { id } = req.params;

    const unreadCount = await deliveryChatService.getUnreadCount(
      id,
      user._id.toString(),
      user.role,
    );

    sendSuccess(
      res,
      { unreadCount, count: unreadCount },
      'Unread count retrieved successfully',
      StatusCodes.OK,
    );
  } catch (error) {
    next(error);
  }
};

/**
 * PATCH /api/v1/deliveries/:id/messages/read
 * Mark unread messages in a delivery as read by the requesting user.
 */
export const markMessagesAsRead = async (
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const user = requireUser(req);
    const { id } = req.params;

    const result = await deliveryChatService.markMessagesAsRead(id, user._id.toString(), user.role);

    sendSuccess(res, result, 'Messages marked as read successfully', StatusCodes.OK);
  } catch (error) {
    next(error);
  }
};
