import { Request, Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import eventLogService from '../services/eventLogService';
import { eventLogRetryService } from '../services/eventLogRetryService';
import { sendSuccess, sendError } from '../utils/responseWrapper';
import logger from '../config/logger';
import { resolveQueryOptions, buildPaginationMeta } from '../middlewares/queryMiddleware';
import { IUser } from '../interfaces/IUser';

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
      const { page, limit, sort } = resolveQueryOptions(req);
      const result = await eventLogService.getUnprocessedEvents(page, limit, sort);
      sendSuccess(
        res,
        {
          events: result.data,
          meta: buildPaginationMeta(result.total, result.page, result.limit),
        },
        'Unprocessed events retrieved successfully',
        StatusCodes.OK,
      );
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

  /**
   * List failed events with their retry state
   * GET /api/v1/admin/eventlog/failed
   */
  async getFailedEvents(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const page = parseInt(req.query.page as string, 10) || 1;
      const limit = parseInt(req.query.limit as string, 10) || 20;
      const result = await eventLogRetryService.listFailed(page, limit);
      sendSuccess(
        res,
        {
          events: result.data,
          meta: buildPaginationMeta(result.total, result.page, result.limit),
        },
        'Failed events retrieved successfully',
        StatusCodes.OK,
      );
    } catch (error) {
      logger.error('Error in getFailedEvents:', error);
      next(error);
    }
  }

  /**
   * Re-run a failed event through the poller's dispatch path now
   * POST /api/v1/admin/eventlog/:id/retry
   */
  async retryFailedEvent(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const user = (req as Request & { user?: IUser }).user;
      const actorId = user?._id ? String(user._id) : null;
      const { outcome, event } = await eventLogRetryService.retryById(req.params.id, actorId);
      const message =
        outcome === 'processed'
          ? 'Event retried and processed successfully'
          : outcome === 'scheduled'
            ? 'Event retry failed; another attempt has been scheduled'
            : 'Event retry failed; retries are exhausted and the event was sent to the DLQ';
      sendSuccess(res, { outcome, event }, message, StatusCodes.OK);
    } catch (error) {
      logger.error('Error in retryFailedEvent:', error);
      next(error);
    }
  }
}

export default new EventLogController();
