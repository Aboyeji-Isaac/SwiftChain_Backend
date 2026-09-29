import { Request, Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import User from '../models/User';
import { userService } from '../services/userService';
import AppError from '../utils/AppError';
import asyncHandler from '../utils/asyncHandler';
import { sendSuccess } from '../utils/responseWrapper';
import type { AuthenticatedRequest } from '../middlewares/authMiddleware';
import { UserRole, UserStatus } from '../interfaces/IUser';

class UserController {
  /**
   * PUT /api/v1/users/wallet
   *
   * Links or updates the authenticated user's Stellar wallet address.
   */
  public updateWallet = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
      const { user } = req as AuthenticatedRequest;
      const userId = user?.userId || user?.id;

      if (!userId) {
        throw new AppError('Authentication required.', StatusCodes.UNAUTHORIZED);
      }

      const { walletAddress } = req.body as { walletAddress: string };

      const existing = await User.findOne({ walletAddress, _id: { $ne: userId } });
      if (existing) {
        throw new AppError(
          'This wallet address is already linked to another account.',
          StatusCodes.CONFLICT,
        );
      }

      const updatedUser = await User.findByIdAndUpdate(
        userId,
        { walletAddress },
        { new: true, runValidators: true },
      );

      if (!updatedUser) {
        throw new AppError('User not found.', StatusCodes.NOT_FOUND);
      }

      sendSuccess(
        res,
        { user: updatedUser },
        'Wallet address updated successfully',
        StatusCodes.OK,
      );
    },
  );

  /**
   * GET /api/v1/users/:id
   *
   * Retrieve a single user by ID.
   * Protected — requires authentication.
   */
  public getUserById = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
      const { id } = req.params;
      const user = await userService.getUserById(id);

      res.status(StatusCodes.OK).json({
        status: 'success',
        data: { user },
      });
    },
  );

  /**
   * PUT /api/v1/users/:id
   *
   * Update user profile fields.
   * Protected — requires authentication and admin role.
   */
  public updateUser = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
      const { id } = req.params;
      const allowedFields = [
        'firstName',
        'lastName',
        'role',
        'status',
        'walletAddress',
        'profilePicture',
        'profilePictureKey',
      ];
      const updateInput: Record<string, unknown> = {};

      for (const key of allowedFields) {
        if (req.body[key] !== undefined) {
          updateInput[key] = req.body[key];
        }
      }

      if (Object.keys(updateInput).length === 0) {
        throw new AppError('No valid fields provided for update.', StatusCodes.BAD_REQUEST);
      }

      const user = await userService.updateUser(id, updateInput);

      res.status(StatusCodes.OK).json({
        status: 'success',
        message: 'User updated successfully',
        data: { user },
      });
    },
  );

  /**
   * DELETE /api/v1/users/:id
   *
   * Soft delete a user and cascade to related records.
   * Protected — requires authentication and admin role.
   */
  public deleteUser = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
      const { user: authUser } = req as AuthenticatedRequest;
      const { id } = req.params;
      const adminId = authUser?.userId || authUser?.id;

      const result = await userService.softDeleteUser(id, adminId);

      res.status(StatusCodes.OK).json({
        status: 'success',
        message: 'User deleted successfully',
        data: {
          user: result.user,
          cascaded: result.cascaded,
        },
      });
    },
  );

  /**
   * POST /api/v1/users/:id/restore
   *
   * Restore a soft-deleted user.
   * Protected — requires authentication and admin role.
   */
  public restoreUser = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
      const { id } = req.params;
      const user = await userService.restoreUser(id);

      res.status(StatusCodes.OK).json({
        status: 'success',
        message: 'User restored successfully',
        data: { user },
      });
    },
  );

  /**
   * PUT /api/v1/users/:id/password
   *
   * Update user password.
   * Protected — requires authentication. Users can only update their own password.
   */
  public updatePassword = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
      const { user: authUser } = req as AuthenticatedRequest;
      const currentUserId = authUser?.userId || authUser?.id;
      const { id } = req.params;

      if (currentUserId !== id) {
        throw new AppError('You can only update your own password.', StatusCodes.FORBIDDEN);
      }

      const { currentPassword, newPassword } = req.body as {
        currentPassword: string;
        newPassword: string;
      };

      if (!currentPassword || !newPassword) {
        throw new AppError(
          'Both currentPassword and newPassword are required.',
          StatusCodes.BAD_REQUEST,
        );
      }

      if (newPassword.length < 8) {
        throw new AppError('New password must be at least 8 characters.', StatusCodes.BAD_REQUEST);
      }

      const user = await userService.updatePassword(id, { currentPassword, newPassword });

      res.status(StatusCodes.OK).json({
        status: 'success',
        message: 'Password updated successfully',
        data: { user },
      });
    },
  );

  /**
   * GET /api/v1/users/deleted
   *
   * List soft-deleted users.
   * Protected — requires authentication and admin role.
   */
  public listDeletedUsers = asyncHandler(
    async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
      const {
        role,
        status,
        search,
        page = '1',
        limit = '10',
      } = req.query as Record<string, unknown>;

      const parsedPage = Math.max(1, parseInt(page as string, 10) || 1);
      const parsedLimit = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 10));

      const filters: Parameters<typeof userService.getDeletedUsers>[0] = {
        page: parsedPage,
        limit: parsedLimit,
      };

      if (role) filters.role = role as UserRole;
      if (status) filters.status = status as UserStatus;
      if (search) filters.search = search as string;

      const result = await userService.getDeletedUsers(filters);

      res.status(StatusCodes.OK).json({
        status: 'success',
        data: result.data,
        pagination: {
          total: result.total,
          page: result.page,
          limit: result.limit,
          totalPages: result.totalPages,
        },
      });
    },
  );
}

export default new UserController();
