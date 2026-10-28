import { Request, Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import {
  createDispute,
  getDisputeById,
  getDisputes,
  resolveDispute,
  addEvidence,
  updateDispute,
} from '../services/disputeService';
import type {
  CreateDisputeInput,
  ResolveDisputeInput,
  AddEvidenceInput,
  UpdateDisputeInput,
} from '../validators/disputeValidator';
import type { IUser } from '../interfaces/IUser';
import AppError from '../utils/AppError';
import { sendSuccess } from '../utils/responseWrapper';
import { resolveQueryOptions, buildPaginationMeta } from '../middlewares/queryMiddleware';

// ─── POST /api/v1/disputes ──────────────────────────────────────

export const openDispute = async (
  req: Request<unknown, unknown, CreateDisputeInput>,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const user = (req as Request & { user?: IUser }).user;

    if (!user) {
      throw new AppError('Authentication required.', StatusCodes.UNAUTHORIZED);
    }

    const { deliveryId, reason, description, evidenceUrls } = req.body;

    const dispute = await createDispute({
      deliveryId,
      raisedBy: user._id.toString(),
      reason,
      description,
      evidenceUrls,
    });

    sendSuccess(res, { dispute }, 'Dispute opened successfully.', StatusCodes.CREATED);
  } catch (error) {
    next(error);
  }
};

// ─── GET /api/v1/disputes/:id ──────────────────────────────────

export const getDispute = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const dispute = await getDisputeById(req.params.id);
    sendSuccess(res, { dispute }, 'Dispute retrieved successfully', StatusCodes.OK);
  } catch (error) {
    next(error);
  }
};

// ─── GET /api/v1/disputes ──────────────────────────────────────

export const listDisputes = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { filter, page, limit, sort } = resolveQueryOptions(req);

    const result = await getDisputes({ filter, page, limit, sort });

    sendSuccess(
      res,
      {
        disputes: result.data,
        meta: buildPaginationMeta(result.total, result.page, result.limit),
      },
      'Disputes retrieved successfully',
      StatusCodes.OK,
    );
  } catch (error) {
    next(error);
  }
};

// ─── PATCH /api/v1/disputes/:id/resolve ────────────────────────

export const resolveDisputeController = async (
  req: Request<{ id: string }, unknown, ResolveDisputeInput>,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const user = (req as Request & { user?: IUser }).user;

    if (!user) {
      throw new AppError('Authentication required.', StatusCodes.UNAUTHORIZED);
    }

    const dispute = await resolveDispute(req.params.id, {
      status: req.body.status,
      resolutionNotes: req.body.resolutionNotes,
      resolvedBy: user._id.toString(),
    });

    sendSuccess(res, { dispute }, `Dispute ${dispute.status} successfully.`, StatusCodes.OK);
  } catch (error) {
    next(error);
  }
};

// ─── PATCH /api/v1/disputes/:id/evidence ───────────────────────────────

export const addEvidenceController = async (
  req: Request<{ id: string }, unknown, AddEvidenceInput>,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const dispute = await addEvidence(req.params.id, {
      evidenceUrls: req.body.evidenceUrls,
    });

    sendSuccess(res, { dispute }, 'Evidence added successfully.', StatusCodes.OK);
  } catch (error) {
    next(error);
  }
};

// ─── PATCH /api/v1/disputes/:id ────────────────────────────────────────

export const updateDisputeController = async (
  req: Request<{ id: string }, unknown, UpdateDisputeInput>,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const dispute = await updateDispute(req.params.id, req.body);

    sendSuccess(res, { dispute }, 'Dispute updated successfully.', StatusCodes.OK);
  } catch (error) {
    next(error);
  }
};
