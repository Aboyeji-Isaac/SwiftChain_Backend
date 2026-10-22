import { Request, Response, NextFunction } from 'express';
import httpStatus from 'http-status-codes';
import { escrowService } from '../services/escrow.service';
import { syncEscrowFundedEvents } from '../indexer/escrowHandlers';
import { AppError } from '../utils/AppError';
import { sendSuccess } from '../utils/responseWrapper';
import logger from '../config/logger';

/**
 * EscrowController handles HTTP requests for escrow records and for
 * manually triggering the escrow_funded indexer.
 *
 * Soroban has no push/webhook mechanism, so the sync endpoint lets
 * operators (or a scheduled job) trigger a poll of the RPC node for new
 * `escrow_funded` events on demand.
 */
export class EscrowController {
  async getByDelivery(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const escrow = await escrowService.getByDeliveryId(req.params.deliveryId);
      sendSuccess(res, escrow, 'Escrow retrieved successfully', httpStatus.OK);
    } catch (error) {
      next(error);
    }
  }

  async getByContract(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const escrow = await escrowService.getByContractId(req.params.contractId);
      sendSuccess(res, escrow, 'Escrow retrieved successfully', httpStatus.OK);
    } catch (error) {
      next(error);
    }
  }

  async fund(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const {
        deliveryId,
        contractId,
        transactionHash,
        amount,
        asset,
        assetIssuer,
        fundedBy,
        ledger,
      } = req.body;

      logger.info(
        `[EscrowController] Fund request received — delivery=${deliveryId} ` +
          `contract=${contractId} tx=${transactionHash}`,
      );

      const escrow = await escrowService.recordEscrowFunded({
        contractId,
        deliveryId,
        amount,
        asset,
        assetIssuer,
        fundedBy,
        transactionHash,
        ledger,
      });

      sendSuccess(res, { escrow }, 'Escrow funded successfully', httpStatus.CREATED);
    } catch (error) {
      next(error);
    }
  }

  async sync(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const startLedger = Number(req.body.startLedger);
      if (!Number.isInteger(startLedger) || startLedger < 0) {
        throw new AppError('startLedger must be a non-negative integer', httpStatus.BAD_REQUEST);
      }

      const contractId: string | undefined = req.body.contractId;
      const summary = await syncEscrowFundedEvents(startLedger, contractId);

      sendSuccess(res, summary, 'Escrow events synced successfully', httpStatus.OK);
    } catch (error) {
      next(error);
    }
  }

  /**
   * Release an escrow.
   *
   * This endpoint uses distributed locking (Redis Redlock) to prevent concurrent
   * requests from releasing the same escrow twice. The lock is acquired before
   * processing and automatically released after completion.
   *
   * Body:
   *   - escrowId: string (required) — MongoDB ObjectId or contractId
   *   - transactionHash: string (required) — On-chain transaction hash
   *   - ledger: number (optional) — Ledger sequence for audit trail
   *
   * @route POST /api/v1/escrow/release
   */
  async release(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { escrowId, transactionHash, ledger } = req.body;

      if (!escrowId || typeof escrowId !== 'string' || escrowId.trim().length === 0) {
        throw new AppError('escrowId is required', httpStatus.BAD_REQUEST);
      }

      if (
        !transactionHash ||
        typeof transactionHash !== 'string' ||
        transactionHash.trim().length === 0
      ) {
        throw new AppError('transactionHash is required', httpStatus.BAD_REQUEST);
      }

      if (ledger !== undefined && (!Number.isInteger(ledger) || ledger < 0)) {
        throw new AppError('ledger must be a non-negative integer', httpStatus.BAD_REQUEST);
      }

      const user = (req as Request & { user?: { _id: string; id: string } }).user;
      const releasedBy = user?._id || user?.id;

      logger.info(
        `[EscrowController] Release request received — escrowId=${escrowId} tx=${transactionHash}`,
      );

      const escrow = await escrowService.releaseEscrow({
        escrowId: escrowId.trim(),
        transactionHash: transactionHash.trim(),
        ledger,
        releasedBy,
      });

      sendSuccess(res, { escrow }, 'Escrow released successfully', httpStatus.OK);
    } catch (error) {
      next(error);
    }
  }
}

export const escrowController = new EscrowController();
