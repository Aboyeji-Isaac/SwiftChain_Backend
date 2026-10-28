import { Request, Response, NextFunction } from 'express';
import authenticateCanonical from './authenticate';
import AppError from '../utils/AppError';

export type AuthenticatedRequest = Request & {
  user?: { role?: string; userId?: string; id?: string; _id?: unknown };
};

/** Canonical database-backed authentication, retained under the old import. */
export const authenticate = authenticateCanonical as (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) => void;

export const authorize = (allowedRoles: string[] = ['driver', 'admin']) => {
  return (req: AuthenticatedRequest, _res: Response, next: NextFunction): void => {
    if (!req.user?.role || !allowedRoles.includes(String(req.user.role))) {
      next(new AppError('Insufficient permissions to perform this action', 403));
      return;
    }
    next();
  };
};
