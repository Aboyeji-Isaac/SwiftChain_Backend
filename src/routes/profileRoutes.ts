import { Router } from 'express';
import multer from 'multer';
import authenticate from '../middleware/authenticate';
import {
  uploadProfilePicture,
  deleteProfilePicture,
  getProfile,
} from '../controllers/profileController';
import env from '../config/env';

const router = Router();

// ─── Multer configuration ──────────────────────────────────────────────────────

/**
 * Configure multer to use memory storage for profile pictures.
 * Files are held in memory as Buffer objects and processed by Sharp
 * before being uploaded to the configured storage backend.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: parseInt(env.PROFILE_PICTURE_MAX_SIZE_MB ?? '5', 10) * 1024 * 1024,
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    // Allow only image MIME types
    const allowedMimeTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];

    if (allowedMimeTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new Error(`Invalid file type. Allowed types: ${allowedMimeTypes.join(', ')}`) as any,
        false,
      );
    }
  },
});

// ─── Routes ────────────────────────────────────────────────────────────────────

/**
 * All profile routes require authentication.
 * The authenticated user's ID is available in req.user._id.
 */
router.use(authenticate);

/**
 * @route   GET /api/v1/profile
 * @desc    Get authenticated user's profile
 * @access  Private (authenticated users only)
 */
router.get('/', getProfile);

/**
 * @route   POST /api/v1/profile/picture
 * @desc    Upload or update profile picture
 * @access  Private (authenticated users only)
 * @body    multipart/form-data with "profilePicture" field
 */
router.post('/picture', upload.single('profilePicture'), uploadProfilePicture);

/**
 * @route   DELETE /api/v1/profile/picture
 * @desc    Remove profile picture
 * @access  Private (authenticated users only)
 */
router.delete('/picture', deleteProfilePicture);

export default router;
