import http from 'http';
import dotenv from 'dotenv';
import app from './app';
import logger from './config/logger';
import { startIndexerLagMonitor } from './services/monitorService';
import {
  initializeSocketServer,
  shutdownSocketServer,
  TypedServer,
} from './sockets/connectionHandler';
import { startEscrowMonitorJob, stopEscrowMonitorJob } from './jobs/escrowMonitor';
import { startWebhookRetryJob, stopWebhookRetryJob } from './jobs/webhookRetryJob';
import { startAutoAssignmentJob, stopAutoAssignmentJob } from './jobs/autoAssignmentJob';
import { startDriverRatingJob, stopDriverRatingJob } from './jobs/driverRatingJob';
import { startEventPoller, stopEventPoller } from './services/eventPoller';
import { initializeRedis, disconnectRedis } from './config/redis';
import env from './config/env';

dotenv.config();

const PORT = env.PORT;

const httpServer = http.createServer(app);
const io: TypedServer = initializeSocketServer(httpServer);

// Initialize Redis connection for distributed locking
const initializeServices = async (): Promise<void> => {
  try {
    await initializeRedis();
    logger.info('✅ Redis connected successfully');
  } catch (error) {
    logger.error('❌ Failed to connect to Redis:', error);
    logger.warn('⚠️ Distributed locking will not be available');
    // Continue without Redis in non-production environments
    if (env.NODE_ENV === 'production') {
      process.exit(1);
    }
  }
};

httpServer.listen(PORT, () => {
  logger.info(`🚀 Server running on port ${PORT} in ${env.NODE_ENV} mode`);
  logger.info(`📝 Health check: http://localhost:${PORT}/health`);
  logger.info(`📦 ETA endpoint: http://localhost:${PORT}/api/v1/deliveries/:id/eta`);

  // Initialize Redis and other services
  initializeServices().catch((error) => logger.error('Error initializing services:', error));

  startIndexerLagMonitor();
});

if (env.NODE_ENV !== 'test') {
  startEscrowMonitorJob();
  startWebhookRetryJob();
  startAutoAssignmentJob();
  startDriverRatingJob();
  startEventPoller();
}

const gracefulShutdown = (): void => {
  logger.info('Shutting down gracefully...');
  stopEventPoller();
  stopEscrowMonitorJob();
  stopWebhookRetryJob();
  stopAutoAssignmentJob();
  stopDriverRatingJob();

  // Disconnect Redis
  disconnectRedis().catch((error) => logger.error('Error disconnecting Redis:', error));

  shutdownSocketServer(io)
    .catch((error) => logger.error('Error shutting down Socket.IO server:', error))
    .finally(() => process.exit(0));
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
