import { Request, Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { profilePictureService } from '../services/profilePicture.service';
import type { IUser } from '../interfaces/IUser';
import AppError from '../utils/AppError';
import { sendSuccess } from '../utils/responseWrapper';
import logger from '../config/logger';

// ─── POST /api/v1/profile/picture ──────────────────────────────────────────────

export const uploadProfilePicture = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const currentUser = (req as Request & { user?: IUser }).user;
    if (!currentUser) {
      throw new AppError('Authentication required', StatusCodes.UNAUTHORIZED);
    }

    const file = (req as Request & { file?: Express.Multer.File }).file;
    if (!file) {
      throw new AppError(
        'Profile picture file is required. Use field name "profilePicture"',
        StatusCodes.BAD_REQUEST,
      );
    }

    logger.info(
      `[ProfileController] Upload request — userId=${currentUser._id} ` +
        `fileName="${file.originalname}" size=${file.size} bytes`,
    );

    const isValid = await profilePictureService.isValidImage(file.buffer);
    if (!isValid) {
      throw new AppError(
        'Invalid image file. Please upload a valid JPEG, PNG, or WebP image',
        StatusCodes.BAD_REQUEST,
      );
    }

    const result = await profilePictureService.uploadProfilePicture({
      userId: currentUser._id.toString(),
      originalName: file.originalname,
      mimeType: file.mimetype,
      buffer: file.buffer,
      sizeBytes: file.size,
    });

    sendSuccess(res, result, 'Profile picture uploaded successfully', StatusCodes.OK);
  } catch (error) {
    next(error);
  }
};

// ─── DELETE /api/v1/profile/picture ────────────────────────────────────────────

export const deleteProfilePicture = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const currentUser = (req as Request & { user?: IUser }).user;
    if (!currentUser) {
      throw new AppError('Authentication required', StatusCodes.UNAUTHORIZED);
    }

    logger.info(`[ProfileController] Delete request — userId=${currentUser._id}`);

    const deleted = await profilePictureService.deleteProfilePicture(currentUser._id.toString());

    if (!deleted) {
      throw new AppError('No profile picture to remove', StatusCodes.NOT_FOUND);
    }

    sendSuccess(res, null, 'Profile picture removed successfully', StatusCodes.OK);
  } catch (error) {
    next(error);
  }
};

// ─── GET /api/v1/profile ───────────────────────────────────────────────────────

export const getProfile = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const currentUser = (req as Request & { user?: IUser }).user;
    if (!currentUser) {
      throw new AppError('Authentication required', StatusCodes.UNAUTHORIZED);
    }

    sendSuccess(
      res,
      { user: currentUser.toJSON() },
      'Profile retrieved successfully',
      StatusCodes.OK,
    );
  } catch (error) {
    next(error);
  }
};
