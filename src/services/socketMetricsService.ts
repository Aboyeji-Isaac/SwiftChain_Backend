/**
 * SocketMetricsService collects and exposes real-time metrics about the
 * Socket.IO gateway's performance: connection counts, message throughput,
 * latency percentiles, and process memory usage.
 *
 * This service is designed to be called by k6 load test harnesses and
 * monitoring dashboards during and after load runs to assess WebSocket
 * performance under stress.
 *
 * The service maintains a rolling window of message latencies in memory
 * and exposes percentile calculations for p50, p95, p99 without external
 * dependencies (no StatsD, Prometheus, etc.).
 */

import logger from '../config/logger';

export interface LatencySnapshot {
  p50: number;
  p95: number;
  p99: number;
}

export interface MemorySnapshot {
  heapUsedMB: number;
  heapTotalMB: number;
  rssMB: number;
  externalMB: number;
}

export interface SocketMetrics {
  connectedSockets: number;
  totalConnections: number;
  totalDisconnections: number;
  messagesProcessed: number;
  messageLatencyMs: LatencySnapshot;
  memoryUsageBytes: MemorySnapshot;
  timestamp: string;
}

/**
 * Rolling window for latency samples: stores up to 10,000 recent message
 * latencies so we can calculate percentiles without requiring external
 * time-series storage.
 */
class LatencyWindow {
  private samples: number[] = [];
  private readonly maxSize = 10_000;

  public record(latencyMs: number): void {
    this.samples.push(latencyMs);
    if (this.samples.length > this.maxSize) {
      this.samples = this.samples.slice(-this.maxSize);
    }
  }

  public percentiles(): LatencySnapshot {
    if (this.samples.length === 0) {
      return { p50: 0, p95: 0, p99: 0 };
    }

    const sorted = [...this.samples].sort((a, b) => a - b);
    const p50Index = Math.floor(sorted.length * 0.5);
    const p95Index = Math.floor(sorted.length * 0.95);
    const p99Index = Math.floor(sorted.length * 0.99);

    return {
      p50: sorted[p50Index],
      p95: sorted[p95Index],
      p99: sorted[p99Index],
    };
  }

  public clear(): void {
    this.samples = [];
  }
}

class SocketMetricsService {
  private connectedSockets: number = 0;
  private totalConnections: number = 0;
  private totalDisconnections: number = 0;
  private messagesProcessed: number = 0;
  private latencyWindow: LatencyWindow = new LatencyWindow();
  private readonly startTime: Date = new Date();

  /**
   * Increment the connected socket count (called on socket connection).
   */
  public recordConnection(): void {
    this.connectedSockets += 1;
    this.totalConnections += 1;
  }

  /**
   * Decrement the connected socket count (called on socket disconnection).
   */
  public recordDisconnection(): void {
    this.connectedSockets = Math.max(0, this.connectedSockets - 1);
    this.totalDisconnections += 1;
  }

  /**
   * Record the latency of a message round-trip or acknowledgement.
   *
   * @param latencyMs Message latency in milliseconds
   */
  public recordMessageLatency(latencyMs: number): void {
    this.latencyWindow.record(latencyMs);
    this.messagesProcessed += 1;
  }

  /**
   * Get a snapshot of all metrics at the current moment.
   */
  public getMetrics(): SocketMetrics {
    const memory = process.memoryUsage();

    return {
      connectedSockets: this.connectedSockets,
      totalConnections: this.totalConnections,
      totalDisconnections: this.totalDisconnections,
      messagesProcessed: this.messagesProcessed,
      messageLatencyMs: this.latencyWindow.percentiles(),
      memoryUsageBytes: {
        heapUsedMB: Math.round((memory.heapUsed / 1024 / 1024) * 100) / 100,
        heapTotalMB: Math.round((memory.heapTotal / 1024 / 1024) * 100) / 100,
        rssMB: Math.round((memory.rss / 1024 / 1024) * 100) / 100,
        externalMB: Math.round((memory.external / 1024 / 1024) * 100) / 100,
      },
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Reset all metrics to zero (useful between test runs).
   */
  public reset(): void {
    this.connectedSockets = 0;
    this.totalConnections = 0;
    this.totalDisconnections = 0;
    this.messagesProcessed = 0;
    this.latencyWindow.clear();
    logger.info('[SocketMetrics] Metrics reset');
  }

  /**
   * Get the time elapsed since service startup.
   */
  public getUptimeSeconds(): number {
    return Math.floor((Date.now() - this.startTime.getTime()) / 1000);
  }
}

export default new SocketMetricsService();
