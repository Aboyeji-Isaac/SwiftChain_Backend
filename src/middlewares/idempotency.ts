import { Request, Response, NextFunction } from 'express';
import httpStatus from 'http-status-codes';
import { idempotencyService } from '../services/idempotency.service';
import { AppError } from '../utils/AppError';
import logger from '../config/logger';

/**
 * Idempotency header name — clients must include this on every request that
 * targets an idempotency-protected endpoint.
 */
export const IDEMPOTENCY_HEADER = 'idempotency-key';

/**
 * Maximum allowed length for the key value (UUID v4 = 36 chars; give extra
 * room for custom schemes without opening the door to payload-size abuse).
 */
const MAX_KEY_LENGTH = 128;

/**
 * requireIdempotencyKey
 *
 * Express middleware that enforces idempotent request handling for mutating
 * endpoints (POST).  Place it **after** authentication middleware so that
 * each key is naturally scoped to the authenticated user/client, and
 * **before** the route handler.
 *
 * Behaviour:
 *  1. Rejects requests that are missing the `Idempotency-Key` header (422).
 *  2. Rejects keys that are empty or exceed `MAX_KEY_LENGTH` (422).
 *  3. First-time request → marks the key as `processing`, delegates to the
 *     next middleware/handler, then persists the response once the handler
 *     has finished writing it.
 *  4. Duplicate request for a `completed` or `failed` key → replays the
 *     cached response immediately without re-executing the handler.
 *  5. Duplicate request while the original is still `processing` → responds
 *     409 Conflict so the caller knows to wait and retry.
 *
 * The `endpoint` discriminator is built from `req.method + req.baseUrl + req.path`
 * so the same UUID is safe to reuse across different routes.
 */
export function requireIdempotencyKey(req: Request, res: Response, next: NextFunction): void {
  // Resolve the endpoint identifier before entering the async IIFE so it is
  // available in the catch block without re-reading from `req`.
  const endpoint = `${req.method}:${req.baseUrl}${req.path}`.replace(/\/+$/, '');
  const rawKey = req.headers[IDEMPOTENCY_HEADER];

  // ── 1. Header presence check ─────────────────────────────────────────────
  if (!rawKey) {
    next(
      new AppError(
        `Missing required header: Idempotency-Key. ` +
          `Include a unique UUID (v4 recommended) with every request to this endpoint.`,
        httpStatus.UNPROCESSABLE_ENTITY,
      ),
    );
    return;
  }

  // The header value must be a plain string, not an array.
  const key = Array.isArray(rawKey) ? rawKey[0] : rawKey;

  // ── 2. Key format validation ──────────────────────────────────────────────
  if (!key || key.trim().length === 0) {
    next(
      new AppError('Idempotency-Key header must not be blank.', httpStatus.UNPROCESSABLE_ENTITY),
    );
    return;
  }

  if (key.length > MAX_KEY_LENGTH) {
    next(
      new AppError(
        `Idempotency-Key exceeds the maximum allowed length of ${MAX_KEY_LENGTH} characters.`,
        httpStatus.UNPROCESSABLE_ENTITY,
      ),
    );
    return;
  }

  // ── 3–5. Async idempotency logic ─────────────────────────────────────────
  void (async () => {
    try {
      const existing = await idempotencyService.get(key, endpoint);

      // ── 4 & 5. Duplicate request ────────────────────────────────────────
      if (existing) {
        if (existing.status === 'processing') {
          // The original request is still in-flight.
          res.setHeader('Idempotency-Key-Status', 'processing');
          next(
            new AppError(
              'A request with this Idempotency-Key is already being processed. ' +
                'Please wait for the original request to complete, then retry if needed.',
              httpStatus.CONFLICT,
            ),
          );
          return;
        }

        // `completed` or `failed` — replay the cached response.
        const cachedStatus = existing.responseStatus ?? httpStatus.OK;
        const cachedBody = existing.responseBody ?? {};

        logger.info(
          `[Idempotency] Replaying cached response for key="${key}" endpoint="${endpoint}" ` +
            `status=${cachedStatus}`,
        );

        res.setHeader('Idempotency-Key-Status', existing.status);
        res.setHeader('Idempotency-Key-Replay', 'true');
        res.status(cachedStatus).json(cachedBody);
        return;
      }

      // ── 3. First-time request — intercept res.json to capture the response ─
      await idempotencyService.markProcessing(key, endpoint);

      // Wrap res.json so we can persist the response body after it is written.
      const originalJson = res.json.bind(res);

      res.json = (body: unknown): Response => {
        // Persist the response before actually sending it so the record is
        // durable even if the connection is dropped mid-flight.
        const statusCode = res.statusCode;
        const safeBody = (body ?? {}) as Record<string, unknown>;

        const persist =
          statusCode >= 200 && statusCode < 300
            ? idempotencyService.markCompleted(key, endpoint, statusCode, safeBody)
            : idempotencyService.markFailed(key, endpoint, statusCode, safeBody);

        persist.catch((err) => {
          // Log but do not abort the response — the client already got their answer.
          logger.error('[Idempotency] Failed to persist response record:', err);
        });

        res.setHeader(
          'Idempotency-Key-Status',
          statusCode >= 200 && statusCode < 300 ? 'completed' : 'failed',
        );
        return originalJson(body);
      };

      next();
    } catch (err) {
      next(err);
    }
  })();
}
