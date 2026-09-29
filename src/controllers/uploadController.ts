import { Request, Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { uploadEvidence, getEvidenceForDispute } from '../services/evidenceService';
import type { IUser } from '../interfaces/IUser';
import AppError from '../utils/AppError';
import { sendSuccess } from '../utils/responseWrapper';

// ─── Request body type ─────────────────────────────────────────────────────────

interface UploadEvidenceBody {
  disputeId?: unknown;
}

// ─── Controller ────────────────────────────────────────────────────────────────

/**
 * POST /api/v1/uploads/evidence
 *
 * Uploads a single piece of media evidence (image, video, or PDF) for a
 * delivery dispute.
 */
export const uploadEvidenceHandler = async (
  req: Request<unknown, unknown, UploadEvidenceBody>,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const currentUser = (req as Request & { user?: IUser }).user;
    if (!currentUser) {
      throw new AppError('Authentication required.', StatusCodes.UNAUTHORIZED);
    }

    const file = (req as Request & { file?: Express.Multer.File }).file;
    if (!file) {
      throw new AppError('A "file" is required.', StatusCodes.BAD_REQUEST);
    }

    const { disputeId } = req.body;
    if (!disputeId || typeof disputeId !== 'string') {
      throw new AppError('A "disputeId" is required.', StatusCodes.BAD_REQUEST);
    }

    const evidence = await uploadEvidence({
      disputeId,
      uploadedBy: currentUser._id.toString(),
      originalName: file.originalname,
      mimeType: file.mimetype,
      buffer: file.buffer,
      sizeBytes: file.size,
    });

    sendSuccess(res, { evidence }, 'Evidence uploaded successfully.', StatusCodes.CREATED);
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/v1/uploads/evidence/:disputeId
 *
 * Lists evidence records linked to a dispute, newest first.
 */
export const listEvidenceHandler = async (
  req: Request<{ disputeId: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { disputeId } = req.params;
    const evidence = await getEvidenceForDispute(disputeId);

    sendSuccess(
      res,
      { evidence, count: evidence.length },
      'Evidence retrieved successfully',
      StatusCodes.OK,
    );
  } catch (error) {
    next(error);
  }
};
