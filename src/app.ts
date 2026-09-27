import path from 'path';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import swaggerUi from 'swagger-ui-express';

import routes from './routes';
import logger from './config/logger';
import { sendError } from './utils/responseWrapper';
import { connectDatabase } from './config/database';
import errorHandler from './middleware/errorHandler';
import requestLogger from './middleware/requestLogger';
import { requestTracker } from './middleware/requestTracker';
import env from './config/env';
import { corsOptionsDelegate, helmetOptions } from './config/security';
import swaggerSpec from './docs/swagger';
import {} from './config/redis';
import { getContainer } from './di';

dotenv.config();

// Initialize DI container at application startup
getContainer();

const app = express();

// Trust the first proxy (load balancer / reverse proxy) so that
// secure headers and rate limiting use the correct client IP.
app.set('trust proxy', 1);

// Secure HTTP headers (Helmet) — hardened policy from config/security.ts.
app.use(helmet(helmetOptions));
app.use(compression());
// Track in-flight requests and reject new ones during graceful shutdown.
app.use(requestTracker);
app.use(requestLogger);

// Swagger UI needs inline <script>/<style>, which the default Helmet CSP
// blocks, so it gets its own relaxed CSP scoped to /api-docs only — the
// rest of the API keeps the strict default policy from helmet() above.
app.use(
  '/api-docs',
  helmet.contentSecurityPolicy({
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'script-src': ["'self'", "'unsafe-inline'"],
      'style-src': ["'self'", "'unsafe-inline'"],
      'img-src': ["'self'", 'data:'],
    },
  }),
  swaggerUi.serve,
  swaggerUi.setup(swaggerSpec),
);

// Cross-Origin Resource Sharing restricted to the configured frontend
// origins (comma-separated CORS_ORIGIN). The delegate resolves the
// allow-list per request and rejects disallowed origins with 403.
app.use(cors(corsOptionsDelegate));

// Rate limiting
const limiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX_REQUESTS,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api', limiter);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serves files written by the local storage driver (used when
// UPLOAD_STORAGE_DRIVER=local). Object keys are unguessable
// (timestamp + UUID), but this directory should not be used for
// sensitive evidence in production — configure the S3 driver instead.
app.use('/uploads', express.static(path.join(process.cwd(), env.UPLOAD_LOCAL_DIR)));

// Lightweight liveness probe for load balancers / container orchestrators.
// The comprehensive MongoDB + Stellar RPC health check lives at
// GET /api/v1/health (src/routes/healthRoutes.ts).
app.get('/health', (_req, res): void => {
  res.status(200).json({
    status: 'success',
    message: 'SwiftChain-Backend is running',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

app.use('/api', routes);

app.use((req, res): void => {
  sendError(res, `Route ${req.path} not found`, 404);
});

// Connect to MongoDB but don't start the server here
const connectDB = async (): Promise<void> => {
  try {
    await connectDatabase();
    logger.info('✅ Connected to MongoDB');
  } catch (error) {
    logger.error('❌ Failed to connect to MongoDB:', error);
    process.exit(1);
  }
};

// Call connectDB but don't listen
if (env.NODE_ENV !== 'test' && !process.env.JEST_WORKER_ID) {
  connectDB();
}

app.use(errorHandler);

export default app;
