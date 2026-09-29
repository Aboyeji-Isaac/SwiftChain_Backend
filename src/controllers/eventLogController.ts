import { Request, Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import eventLogService from '../services/eventLogService';
import { sendSuccess, sendError } from '../utils/responseWrapper';
import logger from '../config/logger';

export class EventLogController {
  /**
   * Get the last processed ledger sequence
   * GET /api/v1/eventlog/last-processed
   */
  async getLastProcessedLedger(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { eventType } = req.query;
      const lastLedger = await eventLogService.getLastProcessedLedger(
        eventType as string | undefined,
      );
      sendSuccess(
        res,
        { lastProcessedLedger: lastLedger },
        'Last processed ledger sequence retrieved successfully',
        StatusCodes.OK,
      );
    } catch (error) {
      logger.error('Error in getLastProcessedLedger:', error);
      next(error);
    }
  }

  /**
   * Get unprocessed events
   * GET /api/v1/eventlog/unprocessed
   */
  async getUnprocessedEvents(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const events = await eventLogService.getUnprocessedEvents();
      sendSuccess(res, events, 'Unprocessed events retrieved successfully', StatusCodes.OK);
    } catch (error) {
      logger.error('Error in getUnprocessedEvents:', error);
      next(error);
    }
  }

  /**
   * Get events by ledger sequence range
   * GET /api/v1/eventlog/range
   */
  async getEventsByLedgerRange(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { startLedger, endLedger, eventType } = req.query;

      if (!startLedger || !endLedger) {
        sendError(res, 'startLedger and endLedger are required', StatusCodes.BAD_REQUEST);
        return;
      }

      const events = await eventLogService.getEventsByLedgerRange(
        parseInt(startLedger as string),
        parseInt(endLedger as string),
        eventType as string | undefined,
      );

      sendSuccess(res, events, 'Events retrieved successfully', StatusCodes.OK);
    } catch (error) {
      logger.error('Error in getEventsByLedgerRange:', error);
      next(error);
    }
  }

  /**
   * Get event by transaction hash
   * GET /api/v1/eventlog/transaction/:hash
   */
  async getEventByTransactionHash(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { hash } = req.params;
      const event = await eventLogService.getEventByTransactionHash(hash);

      if (!event) {
        sendError(res, 'Event not found', StatusCodes.NOT_FOUND);
        return;
      }

      sendSuccess(res, event, 'Event retrieved successfully', StatusCodes.OK);
    } catch (error) {
      logger.error('Error in getEventByTransactionHash:', error);
      next(error);
    }
  }
}

export default new EventLogController();
