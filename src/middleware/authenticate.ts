import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { StatusCodes } from 'http-status-codes';
import User from '../models/User';
import type { IUser } from '../interfaces/IUser';
import AppError from '../utils/AppError';
import env from '../config/env';

// ─── JWT payload shape ────────────────────────────────────────────────────────

interface JwtPayload {
  userId: string; // Changed from 'id' to 'userId' to match login route
  iat?: number;
  exp?: number;
}

// ─── Middleware ───────────────────────────────────────────────────────────────

/**
 * Verifies the `Authorization: Bearer <token>` header, loads the matching
 * User document from the database, and attaches it to `req.user`.
 *
 * Throws 401 if the token is missing, malformed, expired, or references a
 * user that no longer exists.
 * Throws 403 if the user account has been suspended or banned.
 */
const authenticate = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
  try {
    // 1. Extract token from Authorization header
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AppError(
        'Authentication required. Please provide a valid Bearer token.',
        StatusCodes.UNAUTHORIZED,
      );
    }

    const token = authHeader.split(' ')[1];

    // 2. Verify and decode the JWT
    const secret = env.JWT_SECRET;
    if (!secret) {
      throw new AppError(
        'Server misconfiguration: JWT secret not set.',
        StatusCodes.INTERNAL_SERVER_ERROR,
      );
    }

    let decoded: JwtPayload;
    try {
      decoded = jwt.verify(token, secret) as JwtPayload;
    } catch {
      throw new AppError(
        'Invalid or expired token. Please log in again.',
        StatusCodes.UNAUTHORIZED,
      );
    }

    // 3. Load the user from DB using userId (changed from id)
    const user = await User.findById(decoded.userId).select('+password');
    if (!user) {
      throw new AppError(
        'The user associated with this token no longer exists.',
        StatusCodes.UNAUTHORIZED,
      );
    }

    // 4. Block suspended or banned accounts
    if (user.status === 'suspended' || user.status === 'banned') {
      throw new AppError(
        `Your account has been ${user.status}. Please contact support.`,
        StatusCodes.FORBIDDEN,
      );
    }

    // 5. Attach user to request for downstream middleware/controllers
    (req as Request & { user?: IUser }).user = user as unknown as IUser;
    next();
  } catch (error) {
    next(error);
  }
};

export default authenticate;
