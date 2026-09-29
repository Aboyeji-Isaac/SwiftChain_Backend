import http from 'http';
import env from '../config/env';
import logger from '../config/logger';
import { disconnectDatabase, waitForActiveTransactions } from '../config/database';
import { beginRequestDrain, getInFlightRequestCount } from '../middleware/requestTracker';
import { stopIndexerLagMonitor } from './monitorService';
import { stopEscrowMonitorService } from './escrowMonitorService';
import { stopEventPoller } from './eventPoller';
import { shutdownSocketServer, TypedServer } from '../sockets/connectionHandler';
import env from '../config/env';

/** Polling interval while waiting for in-flight HTTP / DB work to finish. */
const DRAIN_POLL_MS = 100;

export interface GracefulShutdownOptions {
  httpServer: http.Server;
  io: TypedServer;
  /** Override exit behaviour (tests inject a spy instead of process.exit). */
  exitFn?: (code: number) => void;
  /** Max milliseconds to wait before a forced exit. */
  timeoutMs?: number;
}

/**
 * Orchestrates a production-safe process teardown:
 *   1. Stop accepting new HTTP / Socket.IO work.
 *   2. Stop background jobs (pollers, monitors, cron).
 *   3. Drain in-flight HTTP requests.
 *   4. Drain and close Socket.IO connections.
 *   5. Wait for active MongoDB transactions, then disconnect.
 *   6. Exit the process.
 *
 * Follows Controller (server signal handlers) → Service (this module) →
 * Model/data-access (`disconnectDatabase`) layering.
 */
export class GracefulShutdownService {
  private readonly httpServer: http.Server;
  private readonly io: TypedServer;
  private readonly exitFn: (code: number) => void;
  private readonly timeoutMs: number;
  private isShuttingDown = false;

  constructor(options: GracefulShutdownOptions) {
    this.httpServer = options.httpServer;
    this.io = options.io;
    this.exitFn = options.exitFn ?? ((code: number) => process.exit(code));
    this.timeoutMs = options.timeoutMs ?? env.SHUTDOWN_TIMEOUT_MS;
  }

  /**
   * Whether a shutdown sequence is already in progress.
   */
  public get shuttingDown(): boolean {
    return this.isShuttingDown;
  }

  /**
   * Run the full graceful shutdown sequence for the given OS signal.
   * Concurrent calls are ignored so SIGTERM + SIGINT cannot race.
   */
  public async shutdown(signal: string): Promise<void> {
    if (this.isShuttingDown) {
      logger.warn(`[Shutdown] Ignoring duplicate ${signal} — shutdown already in progress`);
      return;
    }

    this.isShuttingDown = true;
    logger.info(`[Shutdown] Received ${signal} — beginning graceful drain`);

    const forceTimer = setTimeout(() => {
      logger.error(`[Shutdown] Timed out after ${this.timeoutMs}ms — forcing exit`);
      this.exitFn(1);
    }, this.timeoutMs);
    forceTimer.unref?.();

    try {
      // Reject new HTTP requests immediately.
      beginRequestDrain();

      // Stop background producers of new work before draining.
      this.stopBackgroundJobs();

      // Stop accepting new TCP / HTTP connections; keep-alives closed.
      await this.closeHttpServer();

      // Wait for any requests that were already in flight.
      await this.drainInFlightRequests();

      // Drain Socket.IO clients and close the engine.
      await this.drainSockets();

      // Wait for MongoDB multi-doc transactions, then close the pool.
      await this.drainDatabase();

      logger.info('[Shutdown] Graceful shutdown complete');
      clearTimeout(forceTimer);
      this.exitFn(0);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[Shutdown] Error during graceful shutdown: ${message}`);
      clearTimeout(forceTimer);
      this.exitFn(1);
    }
  }

  private stopBackgroundJobs(): void {
    try {
      stopEventPoller();
      stopEscrowMonitorService();
      stopIndexerLagMonitor();
      logger.info('[Shutdown] Background jobs stopped');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[Shutdown] Failed to stop background jobs: ${message}`);
    }
  }

  private closeHttpServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Close idle keep-alive sockets so close() can finish promptly (Node ≥ 18.2).
      const serverWithIdle = this.httpServer as http.Server & {
        closeIdleConnections?: () => void;
      };
      serverWithIdle.closeIdleConnections?.();

      this.httpServer.close((err) => {
        if (err) {
          // Server was not listening (e.g. already closed) — treat as drained.
          if ((err as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING') {
            logger.info('[Shutdown] HTTP server was not running');
            resolve();
            return;
          }
          reject(err);
          return;
        }
        logger.info('[Shutdown] HTTP server closed — no longer accepting connections');
        resolve();
      });
    });
  }

  private async drainInFlightRequests(): Promise<void> {
    const deadline = Date.now() + this.timeoutMs;

    while (getInFlightRequestCount() > 0 && Date.now() < deadline) {
      logger.info(
        `[Shutdown] Waiting for ${getInFlightRequestCount()} in-flight HTTP request(s)...`,
      );
      await sleep(DRAIN_POLL_MS);
    }

    const remaining = getInFlightRequestCount();
    if (remaining > 0) {
      logger.warn(`[Shutdown] Proceeding with ${remaining} in-flight HTTP request(s) still open`);
    } else {
      logger.info('[Shutdown] In-flight HTTP requests drained');
    }
  }

  private async drainSockets(): Promise<void> {
    try {
      await shutdownSocketServer(this.io);
      logger.info('[Shutdown] Socket.IO connections drained');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[Shutdown] Socket.IO drain error: ${message}`);
      throw error;
    }
  }

  private async drainDatabase(): Promise<void> {
    // Bound the wait for transactions to the remaining shutdown budget.
    const remainingMs = Math.max(1_000, Math.floor(this.timeoutMs / 2));
    await waitForActiveTransactions(remainingMs);
    await disconnectDatabase();
    logger.info('[Shutdown] MongoDB connection closed');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wire SIGTERM / SIGINT to the shutdown service. Replaces ad-hoc handlers
 * so a single path owns process teardown.
 */
export const registerShutdownHandlers = (service: GracefulShutdownService): void => {
  const onSignal = (signal: string): void => {
    void service.shutdown(signal);
  };

  process.once('SIGTERM', () => onSignal('SIGTERM'));
  process.once('SIGINT', () => onSignal('SIGINT'));
};
