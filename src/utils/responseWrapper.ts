/**
 * responseWrapper.ts
 *
 * Centralised HTTP response utility for SwiftChain Backend.
 *
 * Every JSON API response — success or error — is shaped through one of the
 * two helpers exported here so the structure is always:
 *
 * Success:
 * ```json
 * {
 *   "success": true,
 *   "data": <T | null>,
 *   "error": null,
 *   "message": "<human-readable message>"
 * }
 * ```
 *
 * Error:
 * ```json
 * {
 *   "success": false,
 *   "data": null,
 *   "error": "<error description>",
 *   "message": "<human-readable message>"
 * }
 * ```
 *
 * Usage in a controller:
 * ```typescript
 * import { sendSuccess, sendError } from '../utils/responseWrapper';
 *
 * // Success
 * sendSuccess(res, { user }, 'User created successfully', StatusCodes.CREATED);
 *
 * // Error
 * sendError(res, 'User not found', StatusCodes.NOT_FOUND, 'Not Found');
 * ```
 */

import type { Response } from 'express';
import { StatusCodes } from 'http-status-codes';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * The canonical API response envelope used for every JSON response.
 *
 * @template T - The shape of the `data` payload on a successful response.
 */
export interface ApiResponse<T = unknown> {
  /** Indicates whether the request completed without errors. */
  success: boolean;
  /**
   * The response payload on success; `null` on error responses.
   * Using `T | null` rather than `T | undefined` keeps the shape predictable
   * for frontend consumers — the field is always present.
   */
  data: T | null;
  /**
   * A machine-readable error description on failure; `null` on success.
   * Never contains stack traces, credentials, or sensitive infrastructure info.
   */
  error: string | null;
  /** A human-readable message suitable for display or logging. */
  message: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Sends a successful JSON response.
 *
 * @param res        - Express Response object.
 * @param data       - Payload to embed in `data`. Pass `null` when there is no
 *                     payload (e.g. a DELETE that returns nothing).
 * @param message    - Human-readable success message.
 * @param statusCode - HTTP status code (defaults to 200 OK).
 *
 * @example
 * sendSuccess(res, { delivery }, 'Delivery created successfully', StatusCodes.CREATED);
 */
export function sendSuccess<T>(
  res: Response,
  data: T,
  message = 'Operation successful',
  statusCode: number = StatusCodes.OK,
): void {
  const body: ApiResponse<T> = {
    success: true,
    data,
    error: null,
    message,
  };
  res.status(statusCode).json(body);
}

/**
 * Sends an error JSON response.
 *
 * @param res        - Express Response object.
 * @param error      - A short, non-sensitive error description for the `error`
 *                     field (e.g. `'Delivery not found'`).
 * @param statusCode - HTTP status code (defaults to 500 Internal Server Error).
 * @param message    - Human-readable message for the `message` field. Defaults
 *                     to the same value as `error` when omitted.
 *
 * @example
 * sendError(res, 'Delivery not found', StatusCodes.NOT_FOUND);
 * sendError(res, 'Invalid input', StatusCodes.BAD_REQUEST, 'Validation failed');
 */
export function sendError(
  res: Response,
  error: string,
  statusCode: number = StatusCodes.INTERNAL_SERVER_ERROR,
  message?: string,
): void {
  const body: ApiResponse<null> = {
    success: false,
    data: null,
    error,
    message: message ?? error,
  };
  res.status(statusCode).json(body);
}

/**
 * Builds an `ApiResponse` object without sending it.
 * Useful for testing or when the caller needs to inspect/extend the envelope
 * before writing to the response.
 */
export function buildSuccess<T>(data: T, message = 'Operation successful'): ApiResponse<T> {
  return { success: true, data, error: null, message };
}

/**
 * Builds an error `ApiResponse` object without sending it.
 */
export function buildError(error: string, message?: string): ApiResponse<null> {
  return { success: false, data: null, error, message: message ?? error };
}
