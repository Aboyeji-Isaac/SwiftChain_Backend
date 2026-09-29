import { Request, Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { sorobanService } from '../blockchain/soroban.service';
import { sendSuccess, sendError } from '../utils/responseWrapper';
import logger from '../config/logger';

/**
 * StellarController handles HTTP requests related to Stellar / Soroban
 * network interactions.
 *
 * All methods follow the Express request-response pattern and delegate
 * business logic entirely to SorobanService.
 */
export class StellarController {
  /**
   * GET /api/v1/stellar/health
   *
   * Performs a live connectivity check against the configured Soroban RPC
   * node and returns the result.
   *
   * Response 200 — node reachable and healthy.
   * Response 503 — node unreachable or unhealthy.
   */
  public async checkHealth(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await sorobanService.checkConnectivity();

      if (result.connected) {
        sendSuccess(res, result, 'Stellar RPC node is healthy', StatusCodes.OK);
      } else {
        // result is ConnectivityCheckError here — `error` is always present on this branch
        const errMsg =
          !result.connected && 'error' in result
            ? (result as { error: string }).error
            : 'Stellar RPC node is unreachable';
        sendError(res, errMsg, StatusCodes.SERVICE_UNAVAILABLE, 'Stellar RPC node is unhealthy');
      }
    } catch (err) {
      logger.error('[StellarController] Unexpected error in checkHealth:', err);
      next(err);
    }
  }

  /**
   * GET /api/v1/stellar/network
   *
   * Returns network information (passphrase, protocol version) from the
   * Soroban RPC node.
   */
  public async getNetworkInfo(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const info = await sorobanService.getNetworkInfo();
      sendSuccess(res, info, 'Network info retrieved successfully', StatusCodes.OK);
    } catch (err) {
      logger.error('[StellarController] Unexpected error in getNetworkInfo:', err);
      next(err);
    }
  }

  /**
   * GET /api/v1/stellar/ledger/latest
   *
   * Returns the latest ledger sequence number from the Soroban RPC node.
   */
  public async getLatestLedger(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const latestLedger = await sorobanService.getLatestLedger();
      sendSuccess(res, { latestLedger }, 'Latest ledger retrieved successfully', StatusCodes.OK);
    } catch (err) {
      logger.error('[StellarController] Unexpected error in getLatestLedger:', err);
      next(err);
    }
  }
}

/** Singleton instance used by the router. */
export const stellarController = new StellarController();
