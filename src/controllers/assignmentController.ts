import { Request, Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { assignmentService } from '../services/assignmentService';
import { sendSuccess } from '../utils/responseWrapper';

/**
 * POST /api/v1/deliveries/:id/assign-nearest-driver
 *
 * Triggers an on-demand nearest-driver search and assignment for one
 * delivery, using the same logic the auto-assignment sweep runs on a
 * schedule. Useful for dispatchers retrying a delivery that fell through
 * the automatic sweep, or for tests exercising the assignment flow.
 */
export const assignNearestDriver = async (
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const result = await assignmentService.assignNearestDriver(req.params.id);

    const message = result.assigned
      ? 'Nearest available driver assigned successfully.'
      : result.reason ?? 'No driver could be assigned.';

    sendSuccess(res, result, message, result.assigned ? StatusCodes.OK : StatusCodes.CONFLICT);
  } catch (error) {
    next(error);
  }
};
