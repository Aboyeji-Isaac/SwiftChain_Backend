import { NextFunction, Request, Response, Router } from 'express';
import multer, { MulterError } from 'multer';
import { StatusCodes } from 'http-status-codes';
import authenticate from '../middleware/authenticate';
import { bulkCreateDeliveries } from '../controllers/bulkDeliveryController';
import env from '../config/env';
import AppError from '../utils/AppError';

const router = Router();

/**
 * CSV uploads are buffered in memory rather than written to disk: the file is
 * parsed once and discarded, so there is no reason to touch the filesystem.
 * `BULK_UPLOAD_MAX_BYTES` bounds the memory a single request can consume.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.BULK_UPLOAD_MAX_BYTES,
    files: 1,
  },
});

/**
 * Translate multer's own errors into the application's error shape.
 *
 * Without this, an oversized upload surfaces as an unhandled `MulterError`
 * and the client gets a 500 for what is really a 413.
 */
const handleUploadErrors = (
  error: unknown,
  _req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  if (error instanceof MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      const limitMb = (env.BULK_UPLOAD_MAX_BYTES / (1024 * 1024)).toFixed(1);
      next(
        new AppError(`Uploaded file exceeds the ${limitMb}MB limit.`, StatusCodes.REQUEST_TOO_LONG),
      );
      return;
    }

    if (error.code === 'LIMIT_UNEXPECTED_FILE') {
      next(
        new AppError(
          'Unexpected file field. Attach a single file under the "file" field.',
          StatusCodes.BAD_REQUEST,
        ),
      );
      return;
    }

    next(new AppError(`File upload failed: ${error.message}`, StatusCodes.BAD_REQUEST));
    return;
  }

  next(error);
};

/**
 * @route   POST /api/v1/deliveries/bulk
 * @desc    Batch-create deliveries from a CSV file
 * @access  Private
 * @body    multipart/form-data with a "file" field containing the CSV
 *
 * Required columns: trackingNumber, customerName, customerPhone,
 * pickupAddress, dropoffAddress, packageDescription, packageWeight,
 * deliveryFee, escrowAmount.
 * Optional columns: customerEmail, notes.
 */
router.post('/bulk', authenticate, upload.single('file'), handleUploadErrors, bulkCreateDeliveries);

export default router;
