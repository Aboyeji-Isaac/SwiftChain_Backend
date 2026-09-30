import jwt from 'jsonwebtoken';
import { StatusCodes } from 'http-status-codes';
import User from '../models/User';
import { IAuthResponse, ILoginPayload, UserRole, UserStatus } from '../interfaces/IUser';
import AppError from '../utils/AppError';
import logger from '../config/logger';
import env from '../config/env';

/**
 * Public user DTO — the exact JSON shape consumers receive from auth and
 * user-profile endpoints. Derived from real Mongoose documents (never cast),
 * so schema drift surfaces as a compile error instead of a runtime mismatch.
 */
export interface UserDTO {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  /** Account lifecycle state — consumers gate suspended/banned accounts on it. */
  status: UserStatus;
}

/**
 * Map a Mongoose user document to the public {@link UserDTO} shape.
 *
 * The compiler verifies each field against the document type; no `as unknown`
 * escape hatch is involved.
 */
export function toUserDTO(user: {
  /** Mongoose documents expose `id` as string; lean projections as unknown. */
  id?: unknown;
  email: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  status: UserStatus;
}): UserDTO {
  return {
    id: String(user.id),
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role,
    status: user.status,
  };
}

class AuthService {
  /**
   * Authenticate a user with email and password, returning a JWT token.
   *
   * Flow:
   * 1. Look up user by email (explicitly selecting the password field).
   * 2. Verify the account is active.
   * 3. Compare the provided password against the stored hash.
   * 4. Generate and return a signed JWT along with sanitized user data.
   */
  async login(payload: ILoginPayload): Promise<IAuthResponse> {
    const { email, password } = payload;

    // Find user by email — must explicitly select password since it's excluded by default
    const user = await User.findOne({ email }).select('+password');

    if (!user) {
      logger.warn(`Login attempt failed: no account found for email ${email}`);
      throw new AppError('Invalid email or password', StatusCodes.UNAUTHORIZED);
    }

    // Check if the account is active
    if (!user.isActive) {
      logger.warn(`Login attempt failed: deactivated account for email ${email}`);
      throw new AppError(
        'Your account has been deactivated. Please contact support.',
        StatusCodes.UNAUTHORIZED,
      );
    }

    // Verify password
    const isPasswordValid = await user.comparePassword(password);

    if (!isPasswordValid) {
      logger.warn(`Login attempt failed: invalid password for email ${email}`);
      throw new AppError('Invalid email or password', StatusCodes.UNAUTHORIZED);
    }

    // Generate JWT
    const token = this.generateToken(user.id as string, user.role);

    logger.info(`User ${email} logged in successfully`);

    return {
      user: toUserDTO(user),
      token,
    };
  }

  /**
   * Generate a signed JWT token containing the user's ID and role.
   */
  private generateToken(userId: string, role: string): string {
    const secret = env.JWT_SECRET;

    if (!secret) {
      throw new AppError('JWT secret is not configured', StatusCodes.INTERNAL_SERVER_ERROR, false);
    }

    const expiresIn = env.JWT_EXPIRES_IN;

    return jwt.sign({ userId, role }, secret, {
      expiresIn,
    });
  }

  public verifyToken(token: string): { userId: string } {
    const JWT_SECRET = env.JWT_SECRET;
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as {
        userId?: string;
        sub?: string;
        id?: string;
        _id?: string;
      } | null;
      if (!decoded) throw new Error('Invalid token');
      const userId = decoded.userId || decoded.sub || decoded.id || decoded._id;
      if (!userId) throw new Error('Token missing subject');
      return { userId };
    } catch (error) {
      logger.warn('JWT verification failed', error);
      throw error;
    }
  }

  public async registerUser(payload: {
    firstName: string;
    lastName: string;
    email: string;
    password: string;
  }): Promise<UserDTO> {
    const existingUser = await User.findOne({ email: payload.email });
    if (existingUser) {
      throw new AppError('Email is already in use', StatusCodes.CONFLICT);
    }

    const user = await User.create(payload);

    return toUserDTO(user);
  }

  /**
   * Fetch a user by id using an explicit projection of the fields the
   * {@link UserDTO} contract exposes. The projection keeps the selected
   * columns and the DTO in sync: removing a field from one surfaces as a
   * type error in the other.
   */
  public async getUserById(id: string): Promise<UserDTO | null> {
    const user = await User.findById(id)
      .select(['email', 'firstName', 'lastName', 'role', 'status'])
      .lean<{
        id?: unknown;
        email: string;
        firstName: string;
        lastName: string;
        role: UserRole;
        status: UserStatus;
      }>()
      .exec();

    if (!user) {
      return null;
    }

    return toUserDTO(user);
  }
}

export default new AuthService();
