import jwt from 'jsonwebtoken';
import { StatusCodes } from 'http-status-codes';
import User from '../models/User';
import { IAuthResponse, ILoginPayload, IUser } from '../interfaces/IUser';
import AppError from '../utils/AppError';
import logger from '../config/logger';
import env from '../config/env';

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
      user: {
        id: user.id as string,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
      },
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
  }): Promise<Partial<IUser>> {
    const existingUser = await User.findOne({ email: payload.email });
    if (existingUser) {
      throw new AppError('Email is already in use', StatusCodes.CONFLICT);
    }

    const user = await User.create(payload);

    return {
      id: user.id as string,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
    } as unknown as Partial<IUser>;
  }

  public async getUserById(id: string): Promise<IUser | null> {
    return User.findById(id).lean().exec() as unknown as IUser | null;
  }
}

export default new AuthService();
