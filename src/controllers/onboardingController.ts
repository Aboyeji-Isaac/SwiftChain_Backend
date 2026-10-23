import { Request, Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { onboardingService } from '../services/onboardingService';
import type {
  RegisterMerchantBody,
  BindMerchantWalletBody,
} from '../validators/onboardingValidator';
import { sendSuccess } from '../utils/responseWrapper';

// ─── POST /api/v1/onboarding/merchant ─────────────────────────────

export const registerMerchant = async (
  req: Request<Record<string, string>, unknown, RegisterMerchantBody>,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const result = await onboardingService.registerIntent(req.body);
    sendSuccess(
      res,
      result,
      'Onboarding registered. Sign the challenge with the treasury wallet to activate.',
      StatusCodes.CREATED,
    );
  } catch (error) {
    next(error);
  }
};

// ─── PUT /api/v1/onboarding/merchant/wallet ───────────────────────

export const bindMerchantWallet = async (
  req: Request<Record<string, string>, unknown, BindMerchantWalletBody>,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const result = await onboardingService.bindWallet(req.body);
    sendSuccess(res, result, 'Treasury wallet verified and merchant activated.', StatusCodes.OK);
  } catch (error) {
    next(error);
  }
};
