import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { StatusCodes } from 'http-status-codes';
import type { ApiResponse } from '../utils/responseWrapper';

/**
 * Express middleware factory that validates req.body against a Zod schema.
 * Returns a standardised ApiResponse envelope on failure.
 */
const validate =
  (schema: z.ZodType) =>
  (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      const errors = result.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      }));

      const body: ApiResponse<null> & { errors: typeof errors } = {
        success: false,
        data: null,
        error: 'Validation failed',
        message: 'Validation failed',
        errors,
      };

      res.status(StatusCodes.BAD_REQUEST).json(body);
      return;
    }

    req.body = result.data;
    next();
  };

export default validate;
