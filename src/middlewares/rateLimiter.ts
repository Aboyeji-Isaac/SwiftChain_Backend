import rateLimit from 'express-rate-limit';
import env from '../config/env';

const isTest = env.NODE_ENV === 'test' || !!process.env.JEST_WORKER_ID;

/**
 * Strict rate limiter for authentication endpoints (login, register).
 * Prevents brute-force credential attacks.
 * Disabled in test environments to avoid interfering with automated test suites.
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isTest ? 0 : 10, // 0 = unlimited in test mode
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 'error',
    message: 'Too many authentication attempts. Please try again after 15 minutes.',
  },
  skipSuccessfulRequests: false,
});

/**
 * Moderate rate limiter for general public API routes.
 * Guards against DDoS and excessive scraping without blocking normal usage.
 * Disabled in test environments.
 */
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isTest ? 0 : 200, // 0 = unlimited in test mode
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 'error',
    message: 'Too many requests. Please slow down and try again shortly.',
  },
});
