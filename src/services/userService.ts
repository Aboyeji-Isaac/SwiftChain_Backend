import { StatusCodes } from 'http-status-codes';
import mongoose from 'mongoose';
import User from '../models/User';
import DriverProfile from '../models/DriverProfile';
import Delivery, { IDelivery } from '../models/Delivery';
import { IUser, UserRole, UserStatus } from '../interfaces/IUser';
import { AppError } from '../utils/AppError';
import logger from '../config/logger';

// ─── DTOs ──────────────────────────────────────────────────────────────────────

export interface UpdateUserInput {
  firstName?: string;
  lastName?: string;
  role?: UserRole;
  status?: UserStatus;
  walletAddress?: string;
  profilePicture?: string;
  profilePictureKey?: string;
}

export interface UpdatePasswordInput {
  currentPassword: string;
  newPassword: string;
}

export interface UserFilter {
  role?: UserRole;
  status?: UserStatus;
  search?: string;
  page?: number;
  limit?: number;
  includeDeleted?: boolean;
}

export interface PaginatedUserResult {
  data: IUser[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface SoftDeleteResult {
  user: IUser;
  cascaded: {
    driverProfile: boolean;
    deliveries: number;
  };
}

// ─── Service ───────────────────────────────────────────────────────────────────

export class UserService {
  /**
   * Retrieve a single user by ID.
   * By default, excludes soft-deleted users.
   */
  async getUserById(id: string): Promise<IUser> {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new AppError('Invalid user ID format.', StatusCodes.BAD_REQUEST);
    }

    const user = await User.findOne({ _id: id, isDeleted: { $ne: true } });
    if (!user) {
      throw new AppError('User not found.', StatusCodes.NOT_FOUND);
    }

    return user;
  }

  /**
   * List users with optional filtering and pagination.
   */
  async getUsers(filters: UserFilter): Promise<PaginatedUserResult> {
    const { role, status, search, page = 1, limit = 10, includeDeleted = false } = filters;

    const query: Record<string, unknown> = {};

    if (!includeDeleted) {
      query.isDeleted = { $ne: true };
    }

    if (role) {
      query.role = role;
    }

    if (status) {
      query.status = status;
    }

    if (search) {
      query.$or = [
        { email: { $regex: search, $options: 'i' } },
        { firstName: { $regex: search, $options: 'i' } },
        { lastName: { $regex: search, $options: 'i' } },
      ];
    }

    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      User.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).exec(),
      User.countDocuments(query).exec(),
    ]);

    return {
      data: data as IUser[],
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 0,
    };
  }

  /**
   * Update user profile fields.
   */
  async updateUser(id: string, input: UpdateUserInput): Promise<IUser> {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new AppError('Invalid user ID format.', StatusCodes.BAD_REQUEST);
    }

    const user = await User.findOneAndUpdate(
      { _id: id, isDeleted: { $ne: true } },
      { $set: input },
      { new: true, runValidators: true },
    );

    if (!user) {
      throw new AppError('User not found.', StatusCodes.NOT_FOUND);
    }

    logger.info(`User updated: ${user.email}`);
    return user;
  }

  /**
   * Update user password. Requires the current password for verification.
   */
  async updatePassword(id: string, input: UpdatePasswordInput): Promise<IUser> {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new AppError('Invalid user ID format.', StatusCodes.BAD_REQUEST);
    }

    const user = await User.findOne({ _id: id, isDeleted: { $ne: true } }).select('+password');
    if (!user) {
      throw new AppError('User not found.', StatusCodes.NOT_FOUND);
    }

    const isCurrentPasswordValid = await user.comparePassword(input.currentPassword);
    if (!isCurrentPasswordValid) {
      throw new AppError('Current password is incorrect.', StatusCodes.UNAUTHORIZED);
    }

    user.password = input.newPassword;
    await user.save();

    logger.info(`Password updated for user: ${user.email}`);
    return user;
  }

  /**
   * Soft delete a user and cascade to related DriverProfile and Delivery records.
   *
   * Cascading rules:
   *  - DriverProfile belonging to the user is soft-deleted.
   *  - Deliveries where the user is driverId, userId, sender, or recipient are soft-deleted.
   */
  async softDeleteUser(id: string, userId?: string): Promise<SoftDeleteResult> {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new AppError('Invalid user ID format.', StatusCodes.BAD_REQUEST);
    }

    const user = await User.findById(id);
    if (!user) {
      throw new AppError('User not found.', StatusCodes.NOT_FOUND);
    }

    if (user.isDeleted) {
      throw new AppError('User is already deleted.', StatusCodes.CONFLICT);
    }

    let driverProfileDeleted = false;
    let deliveriesDeleted = 0;

    // Cascade: soft-delete driver profile
    const driverProfile = await DriverProfile.findOne({ userId: id });
    if (driverProfile) {
      await (
        driverProfile as unknown as { softDelete(userId?: string): Promise<unknown> }
      ).softDelete(userId);
      driverProfileDeleted = true;
    }

    // Cascade: soft-delete related deliveries
    const deliveryQuery: Record<string, unknown> = {
      isDeleted: { $ne: true },
      $or: [
        { driverId: id },
        { userId: id },
        { sender: new mongoose.Types.ObjectId(id) },
        { recipient: new mongoose.Types.ObjectId(id) },
      ],
    };

    const deliveries = await Delivery.find(deliveryQuery)
      .setOptions({ includeDeleted: true })
      .exec();
    for (const delivery of deliveries) {
      await (delivery as unknown as IDelivery).softDelete(userId);
      deliveriesDeleted++;
    }

    // Soft-delete the user
    await user.softDelete(userId);

    logger.info(
      `User soft-deleted: ${user.email}. Cascaded to ${
        driverProfileDeleted ? 'driver profile, ' : ''
      }${deliveriesDeleted} deliveries.`,
    );

    return {
      user,
      cascaded: {
        driverProfile: driverProfileDeleted,
        deliveries: deliveriesDeleted,
      },
    };
  }

  /**
   * Restore a soft-deleted user.
   * Note: Related DriverProfile and Deliveries are NOT automatically restored
   * to avoid inconsistent state — they must be restored individually if needed.
   */
  async restoreUser(id: string): Promise<IUser> {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new AppError('Invalid user ID format.', StatusCodes.BAD_REQUEST);
    }

    const user = await User.findById(id);
    if (!user) {
      throw new AppError('User not found.', StatusCodes.NOT_FOUND);
    }

    if (!user.isDeleted) {
      throw new AppError('User is not deleted.', StatusCodes.CONFLICT);
    }

    await user.restore();

    logger.info(`User restored: ${user.email}`);
    return user;
  }

  /**
   * List soft-deleted users.
   */
  async getDeletedUsers(filters: Omit<UserFilter, 'includeDeleted'>): Promise<PaginatedUserResult> {
    const { page = 1, limit = 10, ...rest } = filters;

    const query: Record<string, unknown> = { isDeleted: true };

    if (rest.role) {
      query.role = rest.role;
    }

    if (rest.status) {
      query.status = rest.status;
    }

    if (rest.search) {
      query.$or = [
        { email: { $regex: rest.search, $options: 'i' } },
        { firstName: { $regex: rest.search, $options: 'i' } },
        { lastName: { $regex: rest.search, $options: 'i' } },
      ];
    }

    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      User.find(query).sort({ deletedAt: -1 }).skip(skip).limit(limit).exec(),
      User.countDocuments(query).exec(),
    ]);

    return {
      data: data as IUser[],
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 0,
    };
  }
}

export const userService = new UserService();
