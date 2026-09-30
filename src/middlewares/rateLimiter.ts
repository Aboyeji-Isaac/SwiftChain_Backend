import rateLimit from 'express-rate-limit';
import env from '../config/env';

const isTest = env.NODE_ENV === 'test' || !!process.env.JEST_WORKER_ID;

/** Rate-limit ceiling used in test environments so suites are never throttled. */
const TEST_UNLIMITED_MAX = 100_000;

/**
 * Strict rate limiter for authentication endpoints (login, register).
 * Prevents brute-force credential attacks.
 * Effectively disabled in test environments to avoid interfering with
 * automated test suites.
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isTest ? TEST_UNLIMITED_MAX : 10,
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
 * Effectively disabled in test environments.
 */
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isTest ? TEST_UNLIMITED_MAX : 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 'error',
    message: 'Too many requests. Please slow down and try again shortly.',
  },
});
