import { Request, Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { dashboardService, DashboardService } from '../services/dashboardService';
import type { IUser } from '../interfaces/IUser';
import AppError from '../utils/AppError';
import { sendSuccess } from '../utils/responseWrapper';

export class DashboardController {
  private readonly service: DashboardService;

  constructor(service: DashboardService = dashboardService) {
    this.service = service;
  }

  /**
   * GET /api/v1/admin/dashboard
   *
   * Retrieves aggregated system metrics for the admin dashboard:
   *  - Active deliveries (total + breakdown by status)
   *  - Online drivers (total active accounts + recently active locations)
   *  - Total escrow volume (total, locked, released, refunded)
   *  - Soroban RPC connectivity info
   *
   * Protected by `authenticate` + `requireRole(UserRole.ADMIN)`.
   * Query params:
   *  - refresh {boolean} optional: set to true to force bypass of cache.
   */
  public getDashboardMetrics = async (
    req: Request<unknown, unknown, unknown, { refresh?: string }>,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const adminUser = (req as Request & { user?: IUser }).user;

      if (!adminUser) {
        throw new AppError('Authentication required.', StatusCodes.UNAUTHORIZED);
      }

      const forceRefresh = req.query.refresh === 'true' || req.query.refresh === '1';

      const metrics = await this.service.getAdminDashboardMetrics({ forceRefresh });

      sendSuccess(res, metrics, 'Admin dashboard metrics retrieved successfully', StatusCodes.OK);
    } catch (error) {
      next(error);
    }
  };
}

export const dashboardController = new DashboardController();
export const getDashboardMetrics = dashboardController.getDashboardMetrics;
export default dashboardController;
