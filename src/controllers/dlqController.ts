import { Request, Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { dlqService } from '../services/dlqService';
import { sendSuccess } from '../utils/responseWrapper';

export class DlqController {
  /**
   * GET /api/v1/dlq
   * List DLQ entries
   */
  public async getDlqEntries(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const page = parseInt(req.query.page as string, 10) || 1;
      const limit = parseInt(req.query.limit as string, 10) || 10;

      const { data, total } = await dlqService.listEntries(page, limit);

      const totalPages = Math.ceil(total / limit);

      // Construct a response matching the existing patterns
      sendSuccess(
        res,
        { entries: data, pagination: { total, page, limit, totalPages } },
        'DLQ entries retrieved successfully',
      );
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/v1/dlq/:id/retry
   * Retry a specific DLQ entry
   */
  public async retryDlqEntry(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const result = await dlqService.retryEntry(id);

      sendSuccess(res, result, 'DLQ entry retried successfully', StatusCodes.OK);
    } catch (error) {
      next(error);
    }
  }
}

export const dlqController = new DlqController();
