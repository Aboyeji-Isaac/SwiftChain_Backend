import { NextFunction, Request, Response } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { HttpError } from '../utils/httpError';
import env from '../config/env';

const jwtSecret = env.JWT_SECRET;

export interface AuthenticatedRequest extends Request {
  user?: JwtPayload & {
    role?: string;
    sub?: string;
  };
}

export const authenticate = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    next(new HttpError(401, 'Authorization header missing or malformed'));
    return;
  }

  const token = authHeader.split(' ')[1];

  try {
    const payload = jwt.verify(token, jwtSecret);

    if (typeof payload === 'string') {
      next(new HttpError(401, 'Invalid authorization token'));
      return;
    }

    req.user = payload;
    next();
  } catch (error) {
    next(new HttpError(401, 'Invalid or expired authorization token'));
  }
};

export const authorize = (allowedRoles: string[] = ['driver', 'admin']) => {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    const role = req.user?.role;

    if (!role || !allowedRoles.includes(role)) {
      next(new HttpError(403, 'Insufficient permissions to perform this action'));
      return;
    }

    next();
  };
};
