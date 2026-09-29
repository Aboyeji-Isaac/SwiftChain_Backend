import { Request, Response, NextFunction } from 'express';
import httpStatus from 'http-status-codes';
import socketMetricsService from '../services/socketMetricsService';
import { sendSuccess } from '../utils/responseWrapper';

/**
 * SocketMetricsController exposes real-time metrics about the Socket.IO
 * gateway's performance: connection count, message throughput, latency
 * percentiles, and memory usage of the Node.js process.
 *
 * Follows the project's Controller → Service → Model layered pattern:
 *   - Controller  : this file — HTTP glue only
 *   - Service     : socketMetricsService in src/services/socketMetricsService.ts
 *   - Data source : Socket.IO server instance + process.memoryUsage()
 */
export class SocketMetricsController {
  /**
   * GET /api/v1/socket-metrics
   *
   * Returns a snapshot of Socket.IO gateway metrics suitable for consumption
   * by load test harnesses (k6 scripts) and monitoring dashboards.
   *
   * Response includes:
   *   - connectedSockets: Number of currently active WebSocket connections
   *   - totalConnections: Lifetime cumulative connections (useful for detecting leaks)
   *   - messagesProcessed: Cumulative message count
   *   - messageLatencyMs: Percentile latencies (p50, p95, p99)
   *   - memoryUsageBytes: Node.js heap/rss snapshots
   *   - timestamp: UTC ISO string when metrics were sampled
   *
   * HTTP status codes:
   *   200 — metrics successfully sampled
   */
  public getMetrics(req: Request, res: Response, next: NextFunction): void {
    try {
      const metrics = socketMetricsService.getMetrics();
      sendSuccess(res, metrics, 'Socket.IO metrics retrieved', httpStatus.OK);
    } catch (error) {
      next(error);
    }
  }
}

export const socketMetricsController = new SocketMetricsController();
