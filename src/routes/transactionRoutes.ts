import { Router } from 'express';
import { transactionController } from '../controllers/transactionController';
import validate from '../middleware/validate';
import { apiLimiter } from '../middlewares/rateLimiter';
import {
  escrowLockTransactionSchema,
  submitTransactionSchema,
} from '../validators/transactionValidator';

/**
 * Transaction routes.
 *
 * Mounted at /api/v1/transactions by the root router.
 *
 * Endpoints:
 *   POST /api/v1/transactions/escrow-lock — build unsigned escrow-lock XDR
 *   POST /api/v1/transactions/submit      — submit signed XDR with tx_bad_seq retry
 */
const router = Router();

/**
 * @route  POST /api/v1/transactions/escrow-lock
 * @desc   Build an unsigned Soroban XDR that locks a delivery's escrow amount
 * @access Public
 */
router.post(
  '/escrow-lock',
  apiLimiter,
  validate({ body: escrowLockTransactionSchema }),
  transactionController.createEscrowLockTransaction.bind(transactionController),
);

/**
 * @openapi
 * /v1/transactions/submit:
 *   post:
 *     tags: [Transactions]
 *     summary: Submit a signed escrow-lock transaction
 *     description: |
 *       Submits a **signed** transaction envelope XDR to the Stellar network.
 *
 *       Handles `tx_bad_seq` (sequence number mismatch) errors automatically:
 *         1. Re-fetches the account sequence number from the RPC node.
 *         2. Rebuilds the transaction from fresh database state.
 *         3. Returns the new unsigned XDR for the client to re-sign.
 *
 *       Retries are bounded by `STELLAR_BAD_SEQ_MAX_RETRIES` (default: 3).
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [deliveryId, payerAddress, signedXdr]
 *             properties:
 *               deliveryId:
 *                 type: string
 *                 description: MongoDB ObjectId of the delivery
 *               payerAddress:
 *                 type: string
 *                 description: Stellar public key (G...) that signed the transaction
 *               signedXdr:
 *                 type: string
 *                 description: Base64 signed transaction envelope XDR
 *     responses:
 *       200:
 *         description: Transaction confirmed on-chain
 *       400:
 *         description: Validation error
 *       404:
 *         description: Delivery or payer account not found
 *       409:
 *         description: tx_bad_seq retries exhausted — too many concurrent submissions
 *       502:
 *         description: RPC node rejected submission or simulation
 *       503:
 *         description: Escrow contract not configured
 *       504:
 *         description: Transaction not confirmed within polling window
 *
 * @route  POST /api/v1/transactions/submit
 * @desc   Submit a signed escrow-lock XDR with automatic tx_bad_seq retry
 * @access Public
 */
router.post(
  '/submit',
  apiLimiter,
  validate({ body: submitTransactionSchema }),
  transactionController.submitEscrowLockTransaction.bind(transactionController),
);

export default router;
