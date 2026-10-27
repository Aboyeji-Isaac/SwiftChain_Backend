import { Router, Response, NextFunction, Request } from 'express';
import authenticate from '../middleware/authenticate';
import requireRole from '../middleware/requireRole';
import { UserRole } from '../interfaces/IUser';
import env from '../config/env';
import { getPrometheusMetrics } from '../controllers/metricsController';

const router = Router();

/**
 * @openapi
 * /v1/metrics:
 *   get:
 *     tags: [Monitoring]
 *     summary: Export operational metrics in Prometheus format
 *     description: Admin-only endpoint. Disabled unless ENABLE_METRICS=true.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Prometheus text exposition
 *         content:
 *           text/plain:
 *             schema:
 *               type: string
 *       401:
 *         description: Authentication required
 *       403:
 *         description: Admin role required
 *       404:
 *         description: Metrics endpoint is disabled
 */
const requireMetricsEnabled = (_req: Request, res: Response, next: NextFunction): void => {
  if (!env.ENABLE_METRICS) {
    res.status(404).end();
    return;
  }
  next();
};

router.use(requireMetricsEnabled);
router.use(authenticate);
router.use(requireRole(UserRole.ADMIN));
router.get('/', getPrometheusMetrics);

export default router;
