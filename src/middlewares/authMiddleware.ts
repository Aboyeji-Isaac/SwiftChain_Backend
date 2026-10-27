/** Backwards-compatible path for the canonical database-backed middleware. */
export { default, default as authMiddleware } from '../middleware/authenticate';
export type { AuthenticatedRequest } from '../middleware/auth';
