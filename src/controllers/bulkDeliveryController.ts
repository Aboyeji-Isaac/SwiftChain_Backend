import { NextFunction, Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import type { IUser } from '../interfaces/IUser';
import { bulkDeliveryService } from '../services/bulkDeliveryService';
import AppError from '../utils/AppError';
import logger from '../config/logger';

/**
 * BulkDeliveryController — CSV batch creation of deliveries.
 *
 * Accepts `multipart/form-data` with a single `file` field. The upload is held
 * in memory by multer (see the route) and handed to the service as text; no
 * file is written to disk.
 */

/** MIME types browsers and spreadsheet tools use for `.csv`. */
const ACCEPTED_MIME_TYPES = new Set([
  'text/csv',
  'application/csv',
  'text/plain',
  'application/vnd.ms-excel',
  'application/octet-stream',
]);

/** Whether an uploaded file looks like CSV by MIME type or extension. */
export const isAcceptedCsvUpload = (file: Express.Multer.File): boolean =>
  ACCEPTED_MIME_TYPES.has(file.mimetype) || file.originalname.toLowerCase().endsWith('.csv');

// ─── POST /api/v1/deliveries/bulk ──────────────────────────────────────────────

/**
 * Batch-create deliveries from an uploaded CSV file.
 *
 * Responds `201 Created` when every row was imported, and `207 Multi-Status`
 * when some rows were rejected — the body always carries the per-row error
 * report so the client can correct and resubmit only the failures.
 *
 * A file that is entirely unusable (unparseable, missing required columns,
 * over the row limit) is a `400`, raised by the service.
 *
 * Errors:
 *   400 — no file uploaded, wrong type, or the CSV itself is unusable
 *   401 — not authenticated
 *   413 — upload exceeds BULK_UPLOAD_MAX_BYTES (raised by multer)
 *   422 — the file parsed but no row could be imported
 */
export const bulkCreateDeliveries = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const user = (req as Request & { user?: IUser }).user;
    const userId = user?._id ? String(user._id) : undefined;

    if (!userId) {
      throw new AppError('Authentication required.', StatusCodes.UNAUTHORIZED);
    }

    const file = req.file;
    if (!file) {
      throw new AppError(
        'No CSV file uploaded. Attach the file under the "file" field.',
        StatusCodes.BAD_REQUEST,
      );
    }

    if (!isAcceptedCsvUpload(file)) {
      throw new AppError(
        `Unsupported file type "${file.mimetype}". Upload a .csv file.`,
        StatusCodes.BAD_REQUEST,
      );
    }

    const result = await bulkDeliveryService.importFromCsv(file.buffer.toString('utf8'), userId);

    logger.info(
      `[BulkDeliveryController] Import by user=${userId} — ` +
        `created=${result.successCount} failed=${result.failureCount}`,
    );

    // Nothing imported but the file was well-formed: the content is the
    // problem, so 422 rather than 400.
    if (result.successCount === 0) {
      res.status(StatusCodes.UNPROCESSABLE_ENTITY).json({
        status: 'error',
        message: 'No deliveries could be created from the uploaded file',
        data: result,
      });
      return;
    }

    const partial = result.failureCount > 0;

    res.status(partial ? StatusCodes.MULTI_STATUS : StatusCodes.CREATED).json({
      status: partial ? 'partial' : 'success',
      message: partial
        ? `Imported ${result.successCount} of ${result.totalRows} deliveries`
        : `Imported ${result.successCount} deliveries`,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};
