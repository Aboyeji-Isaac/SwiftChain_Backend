import { Request, Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { transactionService } from '../services/transactionService';
import { stellarService } from '../services/stellarService';
import type {
  EscrowLockTransactionBody,
  SubmitTransactionBody,
} from '../validators/transactionValidator';
import { sendSuccess } from '../utils/responseWrapper';

/**
 * TransactionController exposes transaction-building helpers used by the
 * frontend to propose smart-contract calls to a user's wallet.
 *
 * The API never signs or submits anything: it returns unsigned XDR that the
 * client wallet signs locally and submits itself.
 */
export class TransactionController {
  /**
   * POST /api/v1/transactions/escrow-lock
   *
   * Builds the unsigned, simulation-prepared XDR for the escrow-lock
   * invocation of a delivery.
   *
   * Error responses: 400 (validation), 404 (unknown delivery or payer
   * account), 409 (delivery already completed/cancelled), 422 (delivery has no
   * usable escrow amount), 502 (RPC/simulation failure), 503 (escrow contract
   * not configured).
   */
  public async createEscrowLockTransaction(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const { deliveryId, payerAddress } = req.body as EscrowLockTransactionBody;

      const result = await transactionService.buildEscrowLockXdr({ deliveryId, payerAddress });

      sendSuccess(res, result, 'Escrow lock transaction built successfully', StatusCodes.OK);
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/v1/transactions/submit
   *
   * Submits a **signed** escrow-lock transaction envelope to the Stellar
   * network and handles `tx_bad_seq` (sequence number mismatch) errors
   * automatically.
   *
   * Response 200 (confirmed):
   *   Standard ApiResponse with transaction hash and ledger.
   *
   * Response 202 (bad-seq rebuild — client must re-sign):
   *   Standard ApiResponse with refreshedXdr in the data payload.
   *
   * Error responses: 400 (validation), 404 (unknown delivery or account),
   * 409 (bad-seq retries exhausted), 502 (RPC/simulation failure),
   * 503 (contract not configured), 504 (tx not confirmed within poll window).
   */
  public async submitEscrowLockTransaction(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const { deliveryId, payerAddress, signedXdr } = req.body as SubmitTransactionBody;

      const result = await stellarService.submitEscrowLock({
        deliveryId,
        payerAddress,
        signedXdr,
      });

      sendSuccess(res, result, 'Transaction submitted successfully', StatusCodes.OK);
    } catch (error) {
      next(error);
    }
  }
}

/** Singleton instance used by the router. */
export const transactionController = new TransactionController();
