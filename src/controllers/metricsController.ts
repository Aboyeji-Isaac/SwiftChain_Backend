import { Request, Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import prometheusMetricsService from '../services/prometheusMetricsService';

/**
 * Exposes operational metrics in Prometheus text exposition format.
 * Authentication and feature gating are enforced by metricsRoutes.
 */
export const getPrometheusMetrics = async (
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const output = await prometheusMetricsService.render();
    res
      .status(StatusCodes.OK)
      .setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(output);
  } catch (error) {
    next(error);
  }
};
