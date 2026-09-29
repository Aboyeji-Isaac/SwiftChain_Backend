/**
 * EscrowIndexerController
 *
 * HTTP request handlers for escrow indexer operations.
 * Controllers delegate to services — all data sourced from MongoDB.
 */

import { Request, Response, NextFunction } from 'express';
import httpStatus from 'http-status-codes';
import { escrowIndexerService } from '../services/escrowIndexerService';
import { syncEscrowReleasedEvents, syncEscrowRefundedEvents } from '../indexer/escrowHandlers';
import { AppError } from '../utils/AppError';
import { sendSuccess } from '../utils/responseWrapper';
import logger from '../config/logger';

/**
 * Controller for escrow indexer operations.
 * Provides endpoints for querying escrow status and manually triggering event syncs.
 */
export class EscrowIndexerController {
  /**
   * GET /api/v1/indexer/escrows/:escrowId
   *
   * Retrieve current escrow status from database.
   * Useful for debugging and monitoring indexer state.
   *
   * @param req - Express request
   * @param res - Express response
   * @param next - Express next middleware
   */
  async getEscrowStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { escrowId } = req.params;

      if (!escrowId || typeof escrowId !== 'string' || escrowId.trim().length === 0) {
        throw new AppError('escrowId is required', httpStatus.BAD_REQUEST);
      }

      const escrow = await escrowIndexerService.getEscrowByEscrowId(escrowId.trim());

      if (!escrow) {
        throw new AppError(`Escrow ${escrowId} not found`, httpStatus.NOT_FOUND);
      }

      logger.debug(`[EscrowIndexerController] Retrieved escrow status: escrowId=${escrowId}`);

      sendSuccess(res, escrow, 'Escrow status retrieved successfully', httpStatus.OK);
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/v1/indexer/escrows/sync/released
   *
   * Manually trigger a sync of `escrow_released` events from Soroban RPC.
   * Polls the contract for new events starting from the given ledger.
   *
   * Body:
   *   - startLedger: number (required) — Ledger to start from (inclusive)
   *   - contractId: string (optional) — Contract ID (defaults to env var)
   *
   * @param req - Express request
   * @param res - Express response
   * @param next - Express next middleware
   */
  async syncReleased(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { startLedger, contractId } = req.body;

      if (!Number.isInteger(startLedger) || startLedger < 0) {
        throw new AppError('startLedger must be a non-negative integer', httpStatus.BAD_REQUEST);
      }

      if (
        contractId !== undefined &&
        (typeof contractId !== 'string' || contractId.trim().length === 0)
      ) {
        throw new AppError('contractId must be a non-empty string', httpStatus.BAD_REQUEST);
      }

      logger.info(
        `[EscrowIndexerController] Syncing escrow_released events — startLedger=${startLedger}`,
      );

      const summary = await syncEscrowReleasedEvents(startLedger, contractId?.trim());

      sendSuccess(res, summary, 'Escrow released events synced successfully', httpStatus.OK);
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/v1/indexer/escrows/sync/refunded
   *
   * Manually trigger a sync of `escrow_refunded` events from Soroban RPC.
   * Polls the contract for new events starting from the given ledger.
   *
   * Body:
   *   - startLedger: number (required) — Ledger to start from (inclusive)
   *   - contractId: string (optional) — Contract ID (defaults to env var)
   *
   * @param req - Express request
   * @param res - Express response
   * @param next - Express next middleware
   */
  async syncRefunded(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { startLedger, contractId } = req.body;

      if (!Number.isInteger(startLedger) || startLedger < 0) {
        throw new AppError('startLedger must be a non-negative integer', httpStatus.BAD_REQUEST);
      }

      if (
        contractId !== undefined &&
        (typeof contractId !== 'string' || contractId.trim().length === 0)
      ) {
        throw new AppError('contractId must be a non-empty string', httpStatus.BAD_REQUEST);
      }

      logger.info(
        `[EscrowIndexerController] Syncing escrow_refunded events — startLedger=${startLedger}`,
      );

      const summary = await syncEscrowRefundedEvents(startLedger, contractId?.trim());

      sendSuccess(res, summary, 'Escrow refunded events synced successfully', httpStatus.OK);
    } catch (error) {
      next(error);
    }
  }
}

export const escrowIndexerController = new EscrowIndexerController();
