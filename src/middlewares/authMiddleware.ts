import { Request, Response, NextFunction } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { StatusCodes } from 'http-status-codes';
import AppError from '../utils/AppError';
import env from '../config/env';

export interface AuthenticatedRequest extends Request {
  user?: JwtPayload & {
    userId?: string;
    id?: string;
    role?: string;
  };
}

/**
 * Verifies the `Authorization: Bearer <token>` header and attaches the
 * decoded JWT payload to `req.user` for downstream handlers.
 *
 * Throws 401 if the header is missing/malformed or the token is invalid/expired.
 */
export const authMiddleware = (
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction,
): void => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    next(
      new AppError(
        'Authentication required. Please provide a valid Bearer token.',
        StatusCodes.UNAUTHORIZED,
      ),
    );
    return;
  }

  const token = authHeader.split(' ')[1];

  if (!token) {
    next(new AppError('Authentication token missing.', StatusCodes.UNAUTHORIZED));
    return;
  }

  try {
    const decoded = jwt.verify(token, env.JWT_SECRET);

    if (typeof decoded === 'string') {
      next(new AppError('Invalid authorization token.', StatusCodes.UNAUTHORIZED));
      return;
    }

    req.user = decoded;
    next();
  } catch (error) {
    next(new AppError('Invalid or expired token. Please log in again.', StatusCodes.UNAUTHORIZED));
  }
};

export default authMiddleware;
