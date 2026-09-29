import type { CorsOptions, CorsOptionsDelegate } from 'cors';
import type { HelmetOptions } from 'helmet';
import type { Request } from 'express';
import env from './env';
import logger from './logger';
import env from './env';

/**
 * Error raised when a request originates from a disallowed origin.
 * Carries an HTTP status code so the global error handler can respond
 * with `403 Forbidden` instead of a generic `500`.
 */
export class CorsNotAllowedError extends Error {
  public readonly statusCode = 403;

  constructor(origin: string) {
    super(`Origin "${origin}" is not permitted by the CORS policy`);
    this.name = 'CorsNotAllowedError';
  }
}

/**
 * Parse the comma-separated `CORS_ORIGIN` environment variable into a
 * normalized list of allowed frontend origins.
 *
 * Example: `CORS_ORIGIN=http://localhost:3000,https://app.swiftchain.io`
 */
export const getAllowedOrigins = (): string[] =>
  env.CORS_ORIGIN.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

/**
 * Determine whether a given request origin is allowed.
 *
 * - Requests without an `Origin` header (server-to-server, curl, mobile
 *   clients, same-origin navigations) are always permitted.
 * - A configured wildcard (`*`) permits any origin.
 * - Otherwise the origin must be present in the allow-list.
 */
export const isOriginAllowed = (origin: string | undefined, allowedOrigins: string[]): boolean => {
  if (!origin) {
    return true;
  }

  if (allowedOrigins.includes('*')) {
    return true;
  }

  return allowedOrigins.includes(origin);
};

/**
 * CORS configuration delegate.
 *
 * The allow-list is resolved per request so the delegate stays a pure function
 * of the incoming request; the underlying `CORS_ORIGIN` value itself is the
 * validated snapshot exported by `config/env`.
 */
export const corsOptionsDelegate: CorsOptionsDelegate<Request> = (req, callback) => {
  const allowedOrigins = getAllowedOrigins();
  const requestOrigin = req.headers.origin;

  const baseOptions: CorsOptions = {
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    exposedHeaders: ['RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset'],
    maxAge: 86400,
    optionsSuccessStatus: 204,
  };

  if (isOriginAllowed(requestOrigin, allowedOrigins)) {
    callback(null, { ...baseOptions, origin: true });
    return;
  }

  logger.warn(`Blocked CORS request from disallowed origin: ${requestOrigin}`);
  callback(new CorsNotAllowedError(requestOrigin ?? 'unknown'), { ...baseOptions, origin: false });
};

/**
 * Helmet configuration applying production-grade HTTP security headers.
 *
 * Builds on Helmet's secure defaults and additionally enforces a strict
 * Content-Security-Policy and a one-year HSTS policy.
 */
export const helmetOptions: Readonly<HelmetOptions> = {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      fontSrc: ["'self'", 'https:', 'data:'],
      imgSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", 'https:', "'unsafe-inline'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  crossOriginResourcePolicy: { policy: 'same-site' },
  referrerPolicy: { policy: 'no-referrer' },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
};
