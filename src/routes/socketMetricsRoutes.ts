import { Router } from 'express';
import { socketMetricsController } from '../controllers/socketMetricsController';

/**
 * Socket.IO metrics routes.
 *
 * Mounted at /api/v1/socket-metrics by the root router (src/routes/index.ts).
 *
 * Endpoints:
 *   GET /api/v1/socket-metrics — real-time Socket.IO gateway metrics
 *
 * These endpoints are designed for consumption by k6 load test harnesses,
 * monitoring dashboards, and operator debugging. No authentication is required
 * on these endpoints (they can be behind a firewall in production).
 */
const router = Router();

/**
 * @openapi
 * /v1/socket-metrics:
 *   get:
 *     tags: [Monitoring]
 *     summary: Get Socket.IO gateway metrics
 *     description: |
 *       Returns a snapshot of real-time metrics about the Socket.IO WebSocket
 *       gateway's performance:
 *
 *       - **connectedSockets** — Number of currently active WebSocket connections
 *       - **totalConnections** — Lifetime cumulative connections since process start
 *       - **totalDisconnections** — Lifetime cumulative disconnections
 *       - **messagesProcessed** — Cumulative message count processed by handlers
 *       - **messageLatencyMs** — Round-trip or acknowledgement latency percentiles
 *         - p50: median
 *         - p95: 95th percentile
 *         - p99: 99th percentile
 *       - **memoryUsageBytes** — Node.js process memory snapshot
 *         - heapUsedMB: Currently used heap memory
 *         - heapTotalMB: Total allocated heap memory
 *         - rssMB: Resident set size (physical memory)
 *         - externalMB: Memory used by C++ addons
 *       - **timestamp** — UTC ISO 8601 timestamp when metrics were sampled
 *
 *       This endpoint is non-blocking and safe to call frequently from load test
 *       harnesses or monitoring systems. No authentication is required; restrict
 *       access via network ACLs in production.
 *     responses:
 *       200:
 *         description: Metrics successfully retrieved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   properties:
 *                     connectedSockets:
 *                       type: integer
 *                       example: 8500
 *                     totalConnections:
 *                       type: integer
 *                       example: 10000
 *                     totalDisconnections:
 *                       type: integer
 *                       example: 1500
 *                     messagesProcessed:
 *                       type: integer
 *                       example: 45000
 *                     messageLatencyMs:
 *                       type: object
 *                       properties:
 *                         p50:
 *                           type: number
 *                           example: 12.5
 *                         p95:
 *                           type: number
 *                           example: 45.3
 *                         p99:
 *                           type: number
 *                           example: 98.7
 *                     memoryUsageBytes:
 *                       type: object
 *                       properties:
 *                         heapUsedMB:
 *                           type: number
 *                           example: 256.42
 *                         heapTotalMB:
 *                           type: number
 *                           example: 512.0
 *                         rssMB:
 *                           type: number
 *                           example: 768.15
 *                         externalMB:
 *                           type: number
 *                           example: 4.2
 *                     timestamp:
 *                       type: string
 *                       format: date-time
 *                       example: "2024-12-20T14:30:45.123Z"
 */
router.get('/', (req, res, next) => {
  socketMetricsController.getMetrics(req, res, next);
});

export default router;
