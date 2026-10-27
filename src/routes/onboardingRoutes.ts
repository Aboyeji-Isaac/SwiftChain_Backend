import { Router } from 'express';
import validate from '../middleware/validate';
import { authLimiter } from '../middlewares/rateLimiter';
import {
  registerMerchantSchema,
  bindMerchantWalletSchema,
} from '../validators/onboardingValidator';
import { registerMerchant, bindMerchantWallet } from '../controllers/onboardingController';

const router = Router();

/**
 * @openapi
 * /v1/onboarding/merchant:
 *   post:
 *     tags: [Onboarding]
 *     summary: Register merchant onboarding intent
 *     description: >
 *       Public, rate-limited. Validates business metadata, the treasury Stellar address,
 *       contact details and the webhook URL, and returns a wallet-ownership challenge.
 *       No account, fleet or webhook is created until the challenge is signed
 *       (see PUT /v1/onboarding/merchant/wallet).
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [fleetName, treasuryAddress, businessMetadata, contact, webhookUrl]
 *             properties:
 *               fleetName:
 *                 type: string
 *               treasuryAddress:
 *                 type: string
 *                 description: Stellar public key (G...) that will receive escrow payouts
 *               businessMetadata:
 *                 type: object
 *                 required: [companyName, contactEmail]
 *                 properties:
 *                   companyName: { type: string }
 *                   industry: { type: string }
 *                   registrationNumber: { type: string }
 *                   vatNumber: { type: string }
 *                   address:
 *                     type: object
 *                     properties:
 *                       street: { type: string }
 *                       city: { type: string }
 *                       country: { type: string, description: ISO-3166-1 alpha-2 }
 *                       postalCode: { type: string }
 *                   contactEmail: { type: string, format: email }
 *                   contactPhone: { type: string }
 *                   website: { type: string, format: uri }
 *               contact:
 *                 type: object
 *                 required: [firstName, lastName, email]
 *                 properties:
 *                   firstName: { type: string }
 *                   lastName: { type: string }
 *                   email: { type: string, format: email, description: Owner account login }
 *                   phone: { type: string }
 *               webhookUrl:
 *                 type: string
 *                 format: uri
 *                 description: HTTPS endpoint for the default milestone webhook subscription
 *     responses:
 *       201:
 *         description: Intent registered; `data.challenge.message` must be signed by the treasury wallet
 *       400:
 *         description: Validation failed
 *       409:
 *         description: Email or treasury address already belongs to a merchant
 *       429:
 *         description: Rate limit exceeded
 */
router.post('/merchant', authLimiter, validate({ body: registerMerchantSchema }), registerMerchant);

/**
 * @openapi
 * /v1/onboarding/merchant/wallet:
 *   put:
 *     tags: [Onboarding]
 *     summary: Prove treasury wallet ownership and activate the merchant
 *     description: >
 *       Public, rate-limited. `signature` is the base64 Ed25519 signature of the exact
 *       challenge message by the treasury key, either over the raw UTF-8 message or in
 *       SEP-53 form (SHA-256 of "Stellar Signed Message:\n" + message). On success the
 *       enterprise owner account, the fleet and a default webhook subscription for every
 *       delivery milestone are created, and the owner is signed in. The webhook signing
 *       secret is returned once.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [onboardingId, signature, password]
 *             properties:
 *               onboardingId: { type: string }
 *               signature: { type: string, description: base64 }
 *               password: { type: string, minLength: 8, description: Owner account password }
 *     responses:
 *       200:
 *         description: Merchant activated
 *       400:
 *         description: Validation failed
 *       401:
 *         description: Wallet ownership proof rejected
 *       404:
 *         description: Onboarding not found
 *       409:
 *         description: Already completed or being activated, or a collision appeared
 *       410:
 *         description: Challenge expired; start again
 *       429:
 *         description: Too many rejected proofs, or rate limit exceeded
 */
router.put(
  '/merchant/wallet',
  authLimiter,
  validate({ body: bindMerchantWalletSchema }),
  bindMerchantWallet,
);

export default router;
