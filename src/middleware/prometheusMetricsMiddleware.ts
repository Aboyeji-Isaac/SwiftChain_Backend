import { Request, Response, NextFunction } from 'express';
import prometheusMetricsService from '../services/prometheusMetricsService';

/**
 * Records completed HTTP requests using route templates to avoid unbounded
 * cardinality from identifiers and query parameters.
 */
const prometheusMetricsMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  const path = req.path;
  if (
    path === '/metrics' ||
    path === '/metrics/' ||
    path === '/api/v1/metrics' ||
    path === '/api/v1/metrics/'
  ) {
    next();
    return;
  }

  const startedAt = process.hrtime.bigint();
  res.once('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const routePath =
      req.route && typeof req.route.path === 'string'
        ? req.baseUrl + req.route.path || req.route.path
        : 'unmatched';
    prometheusMetricsService.recordRequest(req.method, routePath, res.statusCode, durationMs);
  });

  next();
};

export default prometheusMetricsMiddleware;
