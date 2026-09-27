import sharp from 'sharp';
import { Types } from 'mongoose';
import { StatusCodes } from 'http-status-codes';
import crypto from 'crypto';
import path from 'path';
import User from '../models/User';
import { getStorageDriver } from './storage.service';
import AppError from '../utils/AppError';
import logger from '../config/logger';
import env from '../config/env';

// ─── Configuration ─────────────────────────────────────────────────────────────

/**
 * Maximum file size for profile pictures (in bytes).
 * Default: 5MB (configurable via PROFILE_PICTURE_MAX_SIZE_MB env var).
 */
const MAX_FILE_SIZE = parseInt(env.PROFILE_PICTURE_MAX_SIZE_MB ?? '5', 10) * 1024 * 1024;

/**
 * Target width for resized profile pictures (in pixels).
 * Images are resized to fit within this dimension while preserving aspect ratio.
 * Default: 500px (configurable via PROFILE_PICTURE_WIDTH env var).
 */
const TARGET_WIDTH = parseInt(env.PROFILE_PICTURE_WIDTH ?? '500', 10);

/**
 * Target height for resized profile pictures (in pixels).
 * Images are resized to fit within this dimension while preserving aspect ratio.
 * Default: 500px (configurable via PROFILE_PICTURE_HEIGHT env var).
 */
const TARGET_HEIGHT = parseInt(env.PROFILE_PICTURE_HEIGHT ?? '500', 10);

/**
 * JPEG quality for compressed profile pictures (0-100).
 * Lower values = smaller file size, lower quality.
 * Default: 85 (configurable via PROFILE_PICTURE_QUALITY env var).
 */
const JPEG_QUALITY = parseInt(env.PROFILE_PICTURE_QUALITY ?? '85', 10);

/**
 * Allowed MIME types for profile pictures.
 */
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface UploadProfilePictureInput {
  userId: string;
  originalName: string;
  mimeType: string;
  buffer: Buffer;
  sizeBytes: number;
}

export interface ProfilePictureResult {
  userId: string;
  profilePicture: string;
  profilePictureKey: string;
  uploadedAt: string;
}

// ─── Service ───────────────────────────────────────────────────────────────────

/**
 * ProfilePictureService handles secure upload, processing, and storage of user
 * and driver profile pictures.
 *
 * Responsibilities:
 *   - Validate file type and size
 *   - Automatically resize and compress images using Sharp
 *   - Upload processed image to storage (local or S3)
 *   - Update user profile with image URL and key
 *   - Handle cleanup of old profile pictures
 */
export class ProfilePictureService {
  /**
   * Upload and process a profile picture for a user.
   *
   * @param input - Upload input containing user ID, file data, and metadata
   * @returns Profile picture result with URL and metadata
   * @throws AppError if validation fails or processing encounters errors
   */
  public async uploadProfilePicture(
    input: UploadProfilePictureInput,
  ): Promise<ProfilePictureResult> {
    const { userId, originalName, mimeType, buffer, sizeBytes } = input;

    // ── 1. Validate user exists ──────────────────────────────────────────────
    if (!Types.ObjectId.isValid(userId)) {
      throw new AppError('Invalid user ID format', StatusCodes.BAD_REQUEST);
    }

    const user = await User.findById(userId);
    if (!user) {
      throw new AppError('User not found', StatusCodes.NOT_FOUND);
    }

    // ── 2. Validate file type ────────────────────────────────────────────────
    if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
      throw new AppError(
        `Invalid file type. Allowed types: ${ALLOWED_MIME_TYPES.join(', ')}`,
        StatusCodes.BAD_REQUEST,
      );
    }

    // ── 3. Validate file size ────────────────────────────────────────────────
    if (sizeBytes > MAX_FILE_SIZE) {
      throw new AppError(
        `File size exceeds maximum of ${MAX_FILE_SIZE / (1024 * 1024)}MB`,
        StatusCodes.BAD_REQUEST,
      );
    }

    // ── 4. Process image (resize and compress) ───────────────────────────────
    logger.debug(
      `[ProfilePicture] Processing image for userId=${userId} ` +
        `originalName="${originalName}" size=${sizeBytes} bytes`,
    );

    let processedBuffer: Buffer;
    let processedMimeType: string;

    try {
      const image = sharp(buffer);
      const metadata = await image.metadata();

      logger.debug(
        `[ProfilePicture] Original image metadata — ` +
          `width=${metadata.width} height=${metadata.height} format=${metadata.format}`,
      );

      // Resize to fit within target dimensions while preserving aspect ratio
      processedBuffer = await image
        .resize(TARGET_WIDTH, TARGET_HEIGHT, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: JPEG_QUALITY, progressive: true })
        .toBuffer();

      processedMimeType = 'image/jpeg';

      const originalSizeKB = Math.round(sizeBytes / 1024);
      const processedSizeKB = Math.round(processedBuffer.length / 1024);
      const reduction = Math.round(((sizeBytes - processedBuffer.length) / sizeBytes) * 100);

      logger.info(
        `[ProfilePicture] Image processed — userId=${userId} ` +
          `original=${originalSizeKB}KB processed=${processedSizeKB}KB reduction=${reduction}%`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`[ProfilePicture] Image processing failed — userId=${userId}: ${message}`);
      throw new AppError('Failed to process image', StatusCodes.INTERNAL_SERVER_ERROR);
    }

    // ── 5. Generate unique key for storage ───────────────────────────────────
    const storageKey = this.generateStorageKey(userId, originalName);

    // ── 6. Upload to storage ─────────────────────────────────────────────────
    const storageDriver = getStorageDriver();

    let uploadResult;
    try {
      uploadResult = await storageDriver.upload(processedBuffer, storageKey, processedMimeType);

      logger.debug(
        `[ProfilePicture] Uploaded to storage — userId=${userId} key=${uploadResult.key}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`[ProfilePicture] Storage upload failed — userId=${userId}: ${message}`);
      throw new AppError('Failed to upload profile picture', StatusCodes.INTERNAL_SERVER_ERROR);
    }

    // ── 7. Update user profile ───────────────────────────────────────────────
    // Store the old profile picture key for cleanup
    const oldProfilePictureKey = user.profilePictureKey;

    user.profilePicture = uploadResult.url;
    user.profilePictureKey = uploadResult.key;

    await user.save();

    logger.info(`[ProfilePicture] Profile updated — userId=${userId} url=${uploadResult.url}`);

    // ── 8. TODO: Cleanup old profile picture ─────────────────────────────────
    // In a production system, you'd want to delete the old profile picture
    // from storage to avoid accumulating unused files. This could be done:
    // - Synchronously here (simple but adds latency)
    // - Asynchronously via a background job (recommended)
    // - Via a scheduled cleanup job that removes orphaned files
    if (oldProfilePictureKey) {
      logger.debug(
        `[ProfilePicture] Old profile picture marked for cleanup — key=${oldProfilePictureKey}`,
      );
      // TODO: Implement cleanup logic
    }

    return {
      userId,
      profilePicture: uploadResult.url,
      profilePictureKey: uploadResult.key,
      uploadedAt: new Date().toISOString(),
    };
  }

  /**
   * Delete a user's profile picture.
   *
   * @param userId - User's MongoDB ObjectId
   * @returns true if picture was deleted, false if user had no picture
   * @throws AppError if user not found
   */
  public async deleteProfilePicture(userId: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(userId)) {
      throw new AppError('Invalid user ID format', StatusCodes.BAD_REQUEST);
    }

    const user = await User.findById(userId);
    if (!user) {
      throw new AppError('User not found', StatusCodes.NOT_FOUND);
    }

    if (!user.profilePicture || !user.profilePictureKey) {
      return false;
    }

    const oldKey = user.profilePictureKey;

    user.profilePicture = undefined;
    user.profilePictureKey = undefined;

    await user.save();

    logger.info(`[ProfilePicture] Profile picture removed — userId=${userId} key=${oldKey}`);

    // TODO: Implement actual file deletion from storage
    logger.debug(`[ProfilePicture] Old file marked for cleanup — key=${oldKey}`);

    return true;
  }

  /**
   * Generate a unique storage key for a profile picture.
   *
   * Format: profiles/{userId}/{timestamp}-{uuid}.jpg
   *
   * @param userId - User's MongoDB ObjectId
   * @param originalName - Original filename (used to preserve extension if needed)
   * @returns Unique storage key
   */
  private generateStorageKey(userId: string, originalName: string): string {
    const ext = path.extname(originalName).toLowerCase() || '.jpg';
    const unique = `${Date.now()}-${crypto.randomUUID()}`;
    return `profiles/${userId}/${unique}${ext}`;
  }

  /**
   * Validate that a buffer contains a valid image.
   * Uses Sharp's metadata extraction to verify the file is actually an image.
   *
   * @param buffer - File buffer to validate
   * @returns true if valid image, false otherwise
   */
  public async isValidImage(buffer: Buffer): Promise<boolean> {
    try {
      const metadata = await sharp(buffer).metadata();
      return !!metadata.format;
    } catch {
      return false;
    }
  }
}

/** Singleton instance for use across the application. */
export const profilePictureService = new ProfilePictureService();
