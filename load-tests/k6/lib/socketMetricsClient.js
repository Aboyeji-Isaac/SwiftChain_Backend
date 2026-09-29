import http from 'k6/http';
import { check } from 'k6';
import { API_PREFIX } from './config.js';

/**
 * Service-layer helper: fetches Socket.IO server metrics from the
 * `/api/v1/socket-metrics` endpoint and provides utilities for
 * assertions and reporting during load tests.
 *
 * Used by k6 scenarios to validate latency and connection SLAs.
 */

export class SocketMetricsClient {
  constructor() {
    this.lastMetrics = null;
    this.pollCount = 0;
  }

  /**
   * Fetch the current metrics snapshot from the backend.
   * Returns null if the endpoint is unavailable.
   *
   * @returns {Object|null} Metrics snapshot or null on error
   */
  fetchMetrics() {
    try {
      const res = http.get(`${API_PREFIX}/socket-metrics`, {
        tags: { name: 'FetchSocketMetrics' },
        timeout: '10s',
      });

      check(res, {
        'Socket metrics endpoint responds': (r) => r.status === 200,
      });

      if (res.status === 200) {
        const data = res.json('data');
        this.lastMetrics = data;
        this.pollCount += 1;
        return data;
      }
    } catch (err) {
      // Endpoint may not be ready during early ramp-up; fail silently
    }

    return null;
  }

  /**
   * Check if current latency percentiles meet SLA thresholds.
   *
   * @param {number} p95ThresholdMs - P95 latency threshold in milliseconds
   * @param {number} p99ThresholdMs - P99 latency threshold in milliseconds
   * @returns {boolean} True if metrics are within thresholds
   */
  checkLatencySLA(p95ThresholdMs = 500, p99ThresholdMs = 1000) {
    if (!this.lastMetrics) {
      return false;
    }

    const { messageLatencyMs } = this.lastMetrics;
    if (!messageLatencyMs) {
      return false;
    }

    return messageLatencyMs.p95 <= p95ThresholdMs && messageLatencyMs.p99 <= p99ThresholdMs;
  }

  /**
   * Check if the connection count is within expected range.
   *
   * @param {number} expectedApprox - Expected approximate connection count
   * @param {number} tolerancePercent - Tolerance as a percentage (default 10%)
   * @returns {boolean} True if connected count is within tolerance
   */
  checkConnectionCount(expectedApprox, tolerancePercent = 10) {
    if (!this.lastMetrics) {
      return false;
    }

    const tolerance = (expectedApprox * tolerancePercent) / 100;
    const { connectedSockets } = this.lastMetrics;

    return (
      connectedSockets >= expectedApprox - tolerance &&
      connectedSockets <= expectedApprox + tolerance
    );
  }

  /**
   * Get a formatted summary of the last metrics poll.
   *
   * @returns {string} Human-readable metrics summary
   */
  formatSummary() {
    if (!this.lastMetrics) {
      return 'No metrics available';
    }

    const m = this.lastMetrics;
    return (
      `[Metrics Poll #${this.pollCount}] ` +
      `Connected: ${m.connectedSockets} | ` +
      `Messages: ${m.messagesProcessed} | ` +
      `Latency p95/p99: ${m.messageLatencyMs.p95?.toFixed(1) || 'N/A'}/${m.messageLatencyMs.p99?.toFixed(1) || 'N/A'} ms | ` +
      `Memory: ${m.memoryUsageBytes.heapUsedMB?.toFixed(0) || 'N/A'} MB heap`
    );
  }

  /**
   * Get the last fetched metrics (may be stale).
   *
   * @returns {Object|null} Last metrics snapshot or null if never polled
   */
  getLastMetrics() {
    return this.lastMetrics;
  }
}

export const socketMetricsClient = new SocketMetricsClient();

export default socketMetricsClient;
