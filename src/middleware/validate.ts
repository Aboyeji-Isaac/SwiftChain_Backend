import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { StatusCodes } from 'http-status-codes';
import type { ApiResponse } from '../utils/responseWrapper';

export type ValidationLocation = 'body' | 'query' | 'params';

export interface RequestSchemas {
  body?: z.ZodType;
  query?: z.ZodType;
  params?: z.ZodType;
}

export interface ValidationFieldError {
  location: ValidationLocation;
  field: string;
  message: string;
}

/**
 * Canonical Express validation middleware.
 *
 * Accepts any combination of `{ body, query, params }` Zod schemas, writes the
 * validated (and coerced) values back to req on success, and returns the
 * standardised ApiResponse error envelope with per-field details on failure.
 */
const validate =
  (schemas: RequestSchemas) =>
  (req: Request, res: Response, next: NextFunction): void => {
    const errors: ValidationFieldError[] = [];

    const check = (
      location: ValidationLocation,
      schema: z.ZodType | undefined,
      value: unknown,
    ): unknown => {
      if (!schema) return value;

      const result = schema.safeParse(value);
      if (result.success) return result.data;

      result.error.issues.forEach((issue) =>
        errors.push({ location, field: issue.path.join('.'), message: issue.message }),
      );
      return value;
    };

    const body = check('body', schemas.body, req.body);
    const query = check('query', schemas.query, req.query);
    const params = check('params', schemas.params, req.params);

    if (errors.length > 0) {
      const responseBody: ApiResponse<null> & { errors: ValidationFieldError[] } = {
        success: false,
        data: null,
        error: 'Validation failed',
        message: 'Validation failed',
        errors,
      };

      res.status(StatusCodes.BAD_REQUEST).json(responseBody);
      return;
    }

    req.body = body;
    req.query = query as typeof req.query;
    req.params = params as typeof req.params;
    next();
  };

export default validate;
