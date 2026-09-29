/**
 * HealthController
 *
 * HTTP glue layer for GET /api/v1/health.
 *
 * Architecture: Route → Controller (this file) → Service → Infrastructure.
 *
 * The health endpoint is a special case: on degradation it returns
 * success=false AND a populated data payload (so clients can see which
 * specific service is unhealthy). We build the envelope manually here
 * rather than using sendSuccess/sendError so both fields are correct.
 */

import { Request, Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { checkHealth } from '../services/healthService';
import { type ApiResponse } from '../utils/responseWrapper';
import logger from '../config/logger';

/**
 * GET /api/v1/health
 *
 * Performs a live health check of MongoDB and the Stellar Soroban RPC node.
 *
 * Response 200 — all services healthy:
 * ```json
 * { "success": true, "data": { "status": "healthy", ... }, "error": null, "message": "..." }
 * ```
 *
 * Response 503 — one or more services unhealthy:
 * ```json
 * { "success": false, "data": { "status": "degraded", ... }, "error": null, "message": "..." }
 * ```
 */
export async function getHealth(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await checkHealth();
    const isHealthy = result.status === 'healthy';

    const body: ApiResponse<typeof result> = {
      success: isHealthy,
      data: result,
      error: null,
      message: isHealthy ? 'All services are healthy' : 'One or more services are degraded',
    };

    res.status(isHealthy ? StatusCodes.OK : StatusCodes.SERVICE_UNAVAILABLE).json(body);
  } catch (err) {
    logger.error('[HealthController] Unexpected error during health check:', err);
    next(err);
  }
}
