import { Router } from 'express';
import multer from 'multer';
import { StatusCodes } from 'http-status-codes';
import authenticate from '../middleware/authenticate';
import {
  uploadProofOfDeliveryHandler,
  getProofOfDeliveryHandler,
} from '../controllers/proofOfDeliveryController';
import { ALLOWED_PROOF_MIME_TYPES } from '../services/proofOfDeliveryService';
import env from '../config/env';
import AppError from '../utils/AppError';

const router = Router();

// Buffered in memory and handed to the storage driver inside the service
// layer, matching the evidence-upload pattern in routes/uploadRoutes.ts.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.PROOF_OF_DELIVERY_MAX_SIZE_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (
      !ALLOWED_PROOF_MIME_TYPES.includes(file.mimetype as (typeof ALLOWED_PROOF_MIME_TYPES)[number])
    ) {
      cb(
        new AppError(
          `Unsupported file type "${file.mimetype}".`,
          StatusCodes.UNSUPPORTED_MEDIA_TYPE,
        ),
      );
      return;
    }
    cb(null, true);
  },
});

router.use(authenticate);

/**
 * @route   POST /api/v1/deliveries/:id/proof-of-delivery
 * @desc    Upload the image proving a delivery was completed
 * @access  The assigned driver, or an admin
 */
router.post('/:id/proof-of-delivery', upload.single('file'), uploadProofOfDeliveryHandler);

/**
 * @route   GET /api/v1/deliveries/:id/proof-of-delivery
 * @desc    Fetch the proof-of-delivery record for a delivery
 * @access  Authenticated
 */
router.get('/:id/proof-of-delivery', getProofOfDeliveryHandler);

export default router;
