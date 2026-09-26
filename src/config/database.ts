import mongoose, { ClientSession } from 'mongoose';
import logger from './logger';
import env from './env';

/** Active multi-document sessions started via `startTrackedSession`. */
const activeSessions = new Set<ClientSession>();

export const getActiveTransactionCount = (): number => activeSessions.size;

/**
 * Start a mongoose session that is registered for graceful-shutdown
 * draining. Prefer this over `mongoose.startSession()` for any work that
 * must finish (or be waited on) before the process exits.
 */
export const startTrackedSession = async (): Promise<ClientSession> => {
  const session = await mongoose.startSession();
  activeSessions.add(session);

  const originalEndSession = session.endSession.bind(session);
  session.endSession = (async (...args: Parameters<ClientSession['endSession']>): Promise<void> => {
    activeSessions.delete(session);
    await originalEndSession(...args);
  }) as ClientSession['endSession'];

  return session;
};

/**
 * Poll until all tracked sessions have ended, or until `timeoutMs` elapses.
 * Does not abort sessions — callers should finish or abort their own work.
 */
export const waitForActiveTransactions = async (timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  const pollMs = 100;

  while (activeSessions.size > 0 && Date.now() < deadline) {
    logger.info(`[Database] Waiting for ${activeSessions.size} active transaction session(s)...`);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  if (activeSessions.size > 0) {
    logger.warn(`[Database] Proceeding with ${activeSessions.size} active session(s) still open`);
  } else {
    logger.info('[Database] Active transaction sessions drained');
  }
};

/**
 * Close the mongoose connection after outstanding buffered operations
 * complete (`force = false`). Safe to call when already disconnected.
 */
export const disconnectDatabase = async (): Promise<void> => {
  if (mongoose.connection.readyState === 0) {
    logger.info('[Database] MongoDB already disconnected');
    return;
  }

  await mongoose.connection.close(false);
  logger.info('[Database] MongoDB connection closed');
};

export const connectDatabase = async (): Promise<void> => {
  try {
    const mongoUri = env.MONGODB_URI;

    await mongoose.connect(mongoUri, {
      maxPoolSize: 10, // Maximum number of connections in the pool
      minPoolSize: 2, // Minimum number of connections in the pool
      serverSelectionTimeoutMS: 5000, // Timeout after 5s instead of 30s
      socketTimeoutMS: 45000, // Close sockets after 45s of inactivity
    });

    logger.info('✅ Connected to MongoDB successfully');

    mongoose.connection.on('error', (error) => {
      logger.error('MongoDB connection error:', error);
    });

    mongoose.connection.on('disconnected', () => {
      logger.warn('MongoDB disconnected');
    });

    mongoose.connection.on('reconnected', () => {
      logger.info('✅ MongoDB reconnected');
    });

    mongoose.connection.on('connected', () => {
      logger.info(`MongoDB connected to ${mongoose.connection.host}`);
    });

    // SIGINT / SIGTERM are handled centrally by GracefulShutdownService so
    // we do not register a competing process.exit handler here.
  } catch (error) {
    logger.error('❌ Failed to connect to MongoDB:', error);
    process.exit(1);
  }
};
