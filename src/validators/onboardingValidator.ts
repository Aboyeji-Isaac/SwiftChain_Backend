import { StrKey } from '@stellar/stellar-sdk';
import { z } from 'zod';
import env from '../config/env';

const MIN_PASSWORD_LENGTH = 8;

const optionalText = (max: number) => z.string().trim().min(1).max(max).optional();

/** HTTPS in production; plain HTTP is tolerated elsewhere, matching webhookService. */
const webhookUrl = z
  .url('webhookUrl must be a valid URL')
  .trim()
  .refine((value) => {
    let protocol: string;
    try {
      ({ protocol } = new URL(value));
    } catch {
      // Zod still runs refinements after the URL check fails; let that error stand alone.
      return true;
    }
    return protocol === 'https:' || (protocol === 'http:' && env.NODE_ENV !== 'production');
  }, 'webhookUrl must be an HTTPS URL');

/**
 * Body schema for `POST /api/v1/onboarding/merchant`: registers the intent and
 * validates everything the merchant will be activated with.
 */
export const registerMerchantSchema = z.object({
  fleetName: z.string().trim().min(2, 'fleetName must be at least 2 characters').max(100),
  treasuryAddress: z
    .string()
    .trim()
    .refine(
      (value) => StrKey.isValidEd25519PublicKey(value),
      'treasuryAddress must be a valid Stellar public key (G...)',
    ),
  businessMetadata: z.object({
    companyName: z.string().trim().min(2, 'companyName must be at least 2 characters').max(200),
    industry: optionalText(100),
    registrationNumber: optionalText(100),
    vatNumber: optionalText(100),
    address: z
      .object({
        street: optionalText(200),
        city: optionalText(100),
        country: z
          .string()
          .trim()
          .regex(/^[A-Za-z]{2}$/, 'country must be an ISO-3166-1 alpha-2 code')
          .transform((value) => value.toUpperCase())
          .optional(),
        postalCode: optionalText(20),
      })
      .optional(),
    contactEmail: z.email('contactEmail must be a valid email address').toLowerCase().trim(),
    contactPhone: optionalText(32),
    website: z.url('website must be a valid URL').trim().optional(),
  }),
  contact: z.object({
    firstName: z.string().trim().min(2, 'firstName must be at least 2 characters').max(100),
    lastName: z.string().trim().min(2, 'lastName must be at least 2 characters').max(100),
    email: z.email('contact.email must be a valid email address').toLowerCase().trim(),
    phone: optionalText(32),
  }),
  webhookUrl,
});

export type RegisterMerchantBody = z.infer<typeof registerMerchantSchema>;

/**
 * Body schema for `PUT /api/v1/onboarding/merchant/wallet`: proves ownership
 * of the treasury wallet and sets the owner account's password.
 */
export const bindMerchantWalletSchema = z.object({
  onboardingId: z
    .string()
    .trim()
    .regex(/^[a-f\d]{24}$/i, 'onboardingId must be a valid onboarding id'),
  /** Base64 Ed25519 signature of the challenge message (raw or SEP-53). */
  signature: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'signature must be base64'),
  password: z
    .string({ error: 'password is required' })
    .min(MIN_PASSWORD_LENGTH, `password must be at least ${MIN_PASSWORD_LENGTH} characters`)
    .max(128),
});

export type BindMerchantWalletBody = z.infer<typeof bindMerchantWalletSchema>;
