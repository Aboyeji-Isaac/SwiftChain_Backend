import { Request, Response, NextFunction } from 'express';
import { z, ZodType } from 'zod';
import { StatusCodes } from 'http-status-codes';
import type { ApiResponse } from '../utils/responseWrapper';

interface RequestSchemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

/**
 * Generic Express middleware factory that validates req.body, req.query, and/or
 * req.params against the provided Zod schemas.
 *
 * On success the validated (and coerced) values are written back to req so
 * downstream handlers always receive typed, sanitised data.
 * On failure a standardised ApiResponse 400 is returned with per-field error details.
 */
export const validateRequest =
  (schemas: RequestSchemas) =>
  (req: Request, res: Response, next: NextFunction): void => {
    const errors: Array<{ location: string; field: string; message: string }> = [];

    if (schemas.body) {
      const result = schemas.body.safeParse(req.body);
      if (!result.success) {
        result.error.issues.forEach((issue) =>
          errors.push({ location: 'body', field: issue.path.join('.'), message: issue.message }),
        );
      } else {
        req.body = result.data;
      }
    }

    if (schemas.query) {
      const result = schemas.query.safeParse(req.query);
      if (!result.success) {
        result.error.issues.forEach((issue) =>
          errors.push({ location: 'query', field: issue.path.join('.'), message: issue.message }),
        );
      } else {
        req.query = result.data as typeof req.query;
      }
    }

    if (schemas.params) {
      const result = schemas.params.safeParse(req.params);
      if (!result.success) {
        result.error.issues.forEach((issue) =>
          errors.push({ location: 'params', field: issue.path.join('.'), message: issue.message }),
        );
      } else {
        req.params = result.data as typeof req.params;
      }
    }

    if (errors.length > 0) {
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

    next();
  };

export { z };
