/**
 * onboardingService.ts
 *
 * Self-serve merchant onboarding for escrow-funded deliveries:
 *
 *   1. registerIntent — validate business metadata, treasury address and
 *      contact details, reject anything that would collide with an existing
 *      merchant, and issue a wallet-ownership challenge. Nothing durable is
 *      created yet.
 *   2. bindWallet — verify the treasury wallet signed the challenge, then
 *      activate: create the enterprise owner account, the Fleet (reusing
 *      `Fleet.businessMetadata`) and a default WebhookSubscription for every
 *      delivery milestone, notify the owner and write the audit log.
 *
 * ── Wallet-ownership proof ─────────────────────────────────────────────────────
 * The challenge is a human-readable message naming the onboarding, the
 * treasury address, a random nonce and an expiry. The wallet signs it with
 * its Ed25519 key. Two encodings are accepted so both raw-keypair tooling and
 * browser wallets work:
 *   - raw:    signature over the UTF-8 bytes of the message
 *   - SEP-53: signature over SHA-256("Stellar Signed Message:\n" + message),
 *             which is what wallets implementing SEP-53 `signMessage` produce
 * A rejected proof counts against `ONBOARDING_MAX_PROOF_ATTEMPTS`; once the
 * limit is reached the onboarding is locked and must be started again.
 *
 * ── Activation without transactions ───────────────────────────────────────────
 * The onboarding is first claimed (`pending_wallet` → `activating`) so two
 * concurrent proofs cannot both activate it. If any creation step fails, the
 * documents already created are removed and the claim is released, leaving
 * the merchant free to retry the same onboarding.
 */

import crypto from 'crypto';
import { StatusCodes } from 'http-status-codes';
import { Types } from 'mongoose';
import { Keypair } from '@stellar/stellar-sdk';
import MerchantOnboarding, {
  IMerchantOnboarding,
  OnboardingStatus,
} from '../models/MerchantOnboarding';
import Fleet from '../models/Fleet';
import User from '../models/User';
import AuditLog from '../models/AuditLog';
import WebhookSubscription, {
  IWebhookSubscription,
  WebhookEvent,
} from '../models/WebhookSubscription';
import { IFleet } from '../interfaces/IFleet';
import { UserRole } from '../interfaces/IUser';
import { webhookService } from './webhookService';
import { notificationService } from './notificationService';
import authService, { toUserDTO, UserDTO } from './authService';
import type {
  RegisterMerchantBody,
  BindMerchantWalletBody,
} from '../validators/onboardingValidator';
import AppError from '../utils/AppError';
import logger from '../config/logger';
import env from '../config/env';

// ─── DTOs ──────────────────────────────────────────────────────────────────────

export interface OnboardingChallengeResult {
  onboardingId: string;
  status: OnboardingStatus;
  treasuryAddress: string;
  challenge: {
    /** Sign exactly this text with the treasury wallet. */
    message: string;
    expiresAt: Date;
  };
}

export interface MerchantActivationResult {
  onboardingId: string;
  status: OnboardingStatus;
  user: UserDTO;
  /** JWT for the new owner, so the merchant is signed in straight away. */
  token: string;
  fleet: IFleet;
  webhook: {
    /** The stored subscription, without its secret. */
    subscription: Omit<ReturnType<IWebhookSubscription['toObject']>, 'secret'>;
    /** Signing secret; returned once and never again (rotate to replace it). */
    secret: string;
  };
}

// ─── Constants ─────────────────────────────────────────────────────────────────

/** SEP-53 prefix wallets prepend before hashing a message to sign. */
const SEP53_PREFIX = 'Stellar Signed Message:\n';

const DUPLICATE_KEY_ERROR_CODE = 11000;

/** The default subscription covers every delivery milestone. */
const DEFAULT_WEBHOOK_EVENTS: WebhookEvent[] = Object.values(WebhookEvent);

// ─── Helpers ───────────────────────────────────────────────────────────────────

const buildChallengeMessage = (
  onboardingId: string,
  treasuryAddress: string,
  nonce: string,
  expiresAt: Date,
): string =>
  [
    'SwiftChain merchant onboarding',
    `Onboarding: ${onboardingId}`,
    `Treasury: ${treasuryAddress}`,
    `Nonce: ${nonce}`,
    `Expires: ${expiresAt.toISOString()}`,
  ].join('\n');

/**
 * A freshly created subscription still carries its secret (`select: false`
 * only applies to queries), so strip it before it reaches a response.
 */
const withoutSecret = (
  webhook: IWebhookSubscription,
): Omit<ReturnType<IWebhookSubscription['toObject']>, 'secret'> => {
  const plain = webhook.toObject();
  delete plain.secret;
  return plain;
};

/** True when `signature` is the treasury key's signature of `message`, raw or SEP-53. */
const verifyWalletSignature = (
  treasuryAddress: string,
  message: string,
  signatureBase64: string,
): boolean => {
  let keypair: Keypair;
  try {
    keypair = Keypair.fromPublicKey(treasuryAddress);
  } catch {
    return false;
  }

  const signature = Buffer.from(signatureBase64, 'base64');
  if (signature.length !== 64) return false;

  const raw = Buffer.from(message, 'utf8');
  const sep53 = crypto
    .createHash('sha256')
    .update(Buffer.concat([Buffer.from(SEP53_PREFIX, 'utf8'), raw]))
    .digest();

  return [raw, sep53].some((payload) => {
    try {
      return keypair.verify(payload, signature);
    } catch {
      return false;
    }
  });
};

// ─── Service ───────────────────────────────────────────────────────────────────

export class OnboardingService {
  /**
   * Step 1: register onboarding intent and issue the wallet challenge.
   *
   * @throws {AppError} 409 — the owner email or treasury wallet already
   *         belongs to an existing account or fleet.
   */
  async registerIntent(input: RegisterMerchantBody): Promise<OnboardingChallengeResult> {
    await this.assertNoCollision(input.contact.email, input.treasuryAddress);

    const id = new Types.ObjectId();
    const expiresAt = new Date(Date.now() + env.ONBOARDING_CHALLENGE_TTL_SECONDS * 1000);
    const nonce = crypto.randomBytes(16).toString('hex');
    const message = buildChallengeMessage(String(id), input.treasuryAddress, nonce, expiresAt);

    const onboarding = await MerchantOnboarding.create({
      _id: id,
      status: OnboardingStatus.PENDING_WALLET,
      fleetName: input.fleetName,
      treasuryAddress: input.treasuryAddress,
      businessMetadata: input.businessMetadata,
      contact: input.contact,
      webhookUrl: input.webhookUrl,
      challenge: { message, expiresAt },
    });

    logger.info(
      `[OnboardingService] Intent registered — onboarding=${String(onboarding._id)} ` +
        `treasury=${input.treasuryAddress}`,
    );

    return {
      onboardingId: String(onboarding._id),
      status: onboarding.status,
      treasuryAddress: onboarding.treasuryAddress,
      challenge: { message, expiresAt },
    };
  }

  /**
   * Step 2: verify the treasury wallet signed the challenge, then activate.
   *
   * @throws {AppError} 404 unknown onboarding · 409 already completed or in
   *         progress, or a collision appeared since step 1 · 410 challenge
   *         expired · 429 too many rejected proofs · 401 proof rejected.
   */
  async bindWallet(input: BindMerchantWalletBody): Promise<MerchantActivationResult> {
    const onboarding = await MerchantOnboarding.findById(input.onboardingId);
    if (!onboarding) {
      throw new AppError('Onboarding not found.', StatusCodes.NOT_FOUND);
    }

    if (onboarding.status === OnboardingStatus.COMPLETED) {
      throw new AppError('This onboarding has already been completed.', StatusCodes.CONFLICT);
    }
    if (onboarding.status === OnboardingStatus.ACTIVATING) {
      throw new AppError('This onboarding is already being activated.', StatusCodes.CONFLICT);
    }
    if (onboarding.failedProofAttempts >= env.ONBOARDING_MAX_PROOF_ATTEMPTS) {
      throw new AppError(
        'Too many rejected wallet proofs. Start the onboarding again.',
        StatusCodes.TOO_MANY_REQUESTS,
      );
    }
    if (onboarding.challenge.expiresAt.getTime() <= Date.now()) {
      throw new AppError(
        'The wallet challenge has expired. Start the onboarding again.',
        StatusCodes.GONE,
      );
    }

    if (
      !verifyWalletSignature(
        onboarding.treasuryAddress,
        onboarding.challenge.message,
        input.signature,
      )
    ) {
      await MerchantOnboarding.updateOne(
        { _id: onboarding._id },
        { $inc: { failedProofAttempts: 1 } },
      );
      logger.warn(
        `[OnboardingService] Wallet proof rejected — onboarding=${String(onboarding._id)}`,
      );
      throw new AppError(
        'Wallet ownership proof rejected: the signature does not match the treasury address.',
        StatusCodes.UNAUTHORIZED,
      );
    }

    const claimed = await MerchantOnboarding.findOneAndUpdate(
      { _id: onboarding._id, status: OnboardingStatus.PENDING_WALLET },
      { $set: { status: OnboardingStatus.ACTIVATING } },
      { new: true },
    );
    if (!claimed) {
      throw new AppError('This onboarding is already being activated.', StatusCodes.CONFLICT);
    }

    try {
      return await this.activate(claimed, input.password);
    } catch (error) {
      await MerchantOnboarding.updateOne(
        { _id: claimed._id, status: OnboardingStatus.ACTIVATING },
        { $set: { status: OnboardingStatus.PENDING_WALLET } },
      );
      throw error;
    }
  }

  /** Create the owner, fleet and webhook; undo whatever was created if a step fails. */
  private async activate(
    onboarding: IMerchantOnboarding,
    password: string,
  ): Promise<MerchantActivationResult> {
    // The account or wallet may have been claimed by someone else since step 1.
    await this.assertNoCollision(onboarding.contact.email, onboarding.treasuryAddress);

    const created: { userId?: Types.ObjectId; fleetId?: Types.ObjectId; webhookId?: unknown } = {};

    try {
      const owner = await User.create({
        firstName: onboarding.contact.firstName,
        lastName: onboarding.contact.lastName,
        email: onboarding.contact.email,
        password,
        role: UserRole.ENTERPRISE,
        walletAddress: onboarding.treasuryAddress,
      });
      created.userId = owner._id as Types.ObjectId;

      const fleet = await Fleet.create({
        name: onboarding.fleetName,
        treasuryAddress: onboarding.treasuryAddress,
        ownerId: owner._id,
        businessMetadata: onboarding.businessMetadata,
      });
      created.fleetId = fleet._id as Types.ObjectId;

      const { webhook, secret } = await webhookService.registerWebhook({
        merchantId: String(owner._id),
        url: onboarding.webhookUrl,
        events: DEFAULT_WEBHOOK_EVENTS,
        description: 'Default subscription created during merchant onboarding',
      });
      created.webhookId = webhook._id;

      const completedAt = new Date();
      await MerchantOnboarding.updateOne(
        { _id: onboarding._id },
        {
          $set: {
            status: OnboardingStatus.COMPLETED,
            ownerId: owner._id,
            fleetId: fleet._id,
            webhookId: webhook._id,
            completedAt,
          },
        },
      );

      await notificationService.notifyMerchantOnboarded(String(owner._id), {
        id: String(fleet._id),
        name: fleet.name,
      });
      await this.writeAuditLog(onboarding, owner._id as Types.ObjectId, fleet, webhook);

      logger.info(
        `[OnboardingService] Merchant activated — onboarding=${String(onboarding._id)} ` +
          `owner=${String(owner._id)} fleet=${String(fleet._id)}`,
      );

      return {
        onboardingId: String(onboarding._id),
        status: OnboardingStatus.COMPLETED,
        user: toUserDTO(owner),
        token: authService.generateToken(String(owner._id), owner.role),
        fleet,
        webhook: { subscription: withoutSecret(webhook), secret },
      };
    } catch (error) {
      await this.rollback(created, onboarding);
      // A unique index caught a merchant claiming the same email or wallet
      // between the collision check and the write.
      if ((error as { code?: number }).code === DUPLICATE_KEY_ERROR_CODE) {
        throw new AppError(
          'This email or treasury address was just claimed by another merchant.',
          StatusCodes.CONFLICT,
        );
      }
      throw error;
    }
  }

  private async rollback(
    created: { userId?: Types.ObjectId; fleetId?: Types.ObjectId; webhookId?: unknown },
    onboarding: IMerchantOnboarding,
  ): Promise<void> {
    try {
      if (created.webhookId) await WebhookSubscription.deleteOne({ _id: created.webhookId });
      if (created.fleetId) await Fleet.deleteOne({ _id: created.fleetId });
      if (created.userId) await User.deleteOne({ _id: created.userId });
    } catch (error) {
      logger.error(
        `[OnboardingService] Rollback failed for onboarding=${String(onboarding._id)}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async assertNoCollision(email: string, treasuryAddress: string): Promise<void> {
    const [emailTaken, walletOnUser, walletOnFleet] = await Promise.all([
      User.exists({ email: email.toLowerCase() }),
      User.exists({ walletAddress: treasuryAddress }),
      Fleet.exists({ treasuryAddress }),
    ]);

    if (emailTaken) {
      throw new AppError('An account with this email already exists.', StatusCodes.CONFLICT);
    }
    if (walletOnUser || walletOnFleet) {
      throw new AppError(
        'This treasury address is already bound to an existing merchant.',
        StatusCodes.CONFLICT,
      );
    }
  }

  private async writeAuditLog(
    onboarding: IMerchantOnboarding,
    ownerId: Types.ObjectId,
    fleet: IFleet,
    webhook: IWebhookSubscription,
  ): Promise<void> {
    try {
      await AuditLog.create({
        action: 'merchant.onboarded',
        actor: ownerId,
        targetType: 'Fleet',
        targetId: fleet._id,
        description: `Merchant ${onboarding.businessMetadata.companyName} onboarded`,
        meta: {
          onboardingId: String(onboarding._id),
          treasuryAddress: onboarding.treasuryAddress,
          webhookId: String(webhook._id),
          webhookEvents: webhook.events,
        },
      });
    } catch (error) {
      logger.error(
        `[OnboardingService] Failed to write audit log for onboarding=${String(onboarding._id)}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const onboardingService = new OnboardingService();
export default onboardingService;
