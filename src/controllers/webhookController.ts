import { Request, Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { webhookService } from '../services/webhookService';
import type { RegisterWebhookInput, UpdateWebhookInput } from '../validators/webhookValidator';
import type { IUser } from '../interfaces/IUser';
import AppError from '../utils/AppError';
import { sendSuccess } from '../utils/responseWrapper';
import { resolveQueryOptions, buildPaginationMeta } from '../middlewares/queryMiddleware';

function requireUser(req: Request): IUser {
  const user = (req as Request & { user?: IUser }).user;
  if (!user) {
    throw new AppError('Authentication required.', StatusCodes.UNAUTHORIZED);
  }
  return user;
}

// ─── POST /api/v1/webhooks ──────────────────────────────────────

export const registerWebhook = async (
  req: Request<Record<string, string>, unknown, RegisterWebhookInput>,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const user = requireUser(req);

    const { webhook, secret } = await webhookService.registerWebhook({
      merchantId: user._id.toString(),
      url: req.body.url,
      events: req.body.events,
      description: req.body.description,
    });

    sendSuccess(
      res,
      { webhook, secret },
      'Webhook registered successfully. Store this secret now — it will not be shown again.',
      StatusCodes.CREATED,
    );
  } catch (error) {
    next(error);
  }
};

// ─── GET /api/v1/webhooks ────────────────────────────────────────

export const listWebhooks = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const user = requireUser(req);
    const { filter, page, limit, sort } = resolveQueryOptions(req);
    const result = await webhookService.listForMerchant(user._id.toString(), {
      filter,
      page,
      limit,
      sort,
    });
    sendSuccess(
      res,
      { webhooks: result.data, meta: buildPaginationMeta(result.total, result.page, result.limit) },
      'Webhooks retrieved successfully',
      StatusCodes.OK,
    );
  } catch (error) {
    next(error);
  }
};

// ─── GET /api/v1/webhooks/:id ────────────────────────────────────

export const getWebhook = async (
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const user = requireUser(req);
    const webhook = await webhookService.getById(user._id.toString(), req.params.id);
    sendSuccess(res, { webhook }, 'Webhook retrieved successfully', StatusCodes.OK);
  } catch (error) {
    next(error);
  }
};

// ─── PATCH /api/v1/webhooks/:id ──────────────────────────────────

export const updateWebhook = async (
  req: Request<{ id: string }, unknown, UpdateWebhookInput>,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const user = requireUser(req);
    const webhook = await webhookService.updateWebhook(
      user._id.toString(),
      req.params.id,
      req.body,
    );
    sendSuccess(res, { webhook }, 'Webhook updated successfully', StatusCodes.OK);
  } catch (error) {
    next(error);
  }
};

// ─── DELETE /api/v1/webhooks/:id ─────────────────────────────────

export const deleteWebhook = async (
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const user = requireUser(req);
    await webhookService.deleteWebhook(user._id.toString(), req.params.id);
    sendSuccess(res, null, 'Webhook deleted successfully', StatusCodes.OK);
  } catch (error) {
    next(error);
  }
};

// ─── POST /api/v1/webhooks/:id/rotate-secret ─────────────────────

export const rotateWebhookSecret = async (
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const user = requireUser(req);
    const { webhook, secret } = await webhookService.rotateSecret(
      user._id.toString(),
      req.params.id,
    );

    sendSuccess(
      res,
      { webhook, secret },
      'Secret rotated successfully. Store this secret now — it will not be shown again.',
      StatusCodes.OK,
    );
  } catch (error) {
    next(error);
  }
};
