import { Router } from 'express';
import { circuitBreakerController } from '../controllers/circuitBreakerController';
import { getHealth } from '../controllers/healthController';

/**
 * Health routes.
 *
 * Mounted at /api/v1/health by the root router (src/routes/index.ts).
 *
 * Endpoints:
 *   GET /api/v1/health                  — comprehensive MongoDB + Stellar RPC health check
 *   GET /api/v1/health/circuit-breakers — live state of all circuit breakers
 */
const router = Router();

/**
 * @openapi
 * /v1/health:
 *   get:
 *     tags: [Health]
 *     summary: Comprehensive service health check
 *     description: |
 *       Checks the connectivity of all required backend dependencies:
 *         - **MongoDB** — verifies the Mongoose connection state and issues a
 *           live `ping` command to confirm the database is accepting queries.
 *         - **Stellar / Soroban RPC** — calls `getHealth()` and
 *           `getLatestLedger()` against the configured RPC node via the
 *           SorobanService circuit-breaker (retries + timeout included).
 *
 *       Returns HTTP 200 when all services are healthy, 503 when any service
 *       is degraded. The response body always includes per-service detail so
 *       monitoring tools can identify which dependency is failing without
 *       needing to parse log files.
 *     responses:
 *       200:
 *         description: All services healthy
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/HealthResponse'
 *       503:
 *         description: One or more services are unhealthy
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/HealthResponse'
 */
router.get('/', (req, res, next) => {
  void getHealth(req, res, next);
});

/**
 * @openapi
 * /v1/health/circuit-breakers:
 *   get:
 *     tags: [Health]
 *     summary: Get circuit breaker states
 *     description: |
 *       Returns the runtime state and rolling statistics for every circuit
 *       breaker registered in the process (Google Maps, Soroban RPC, etc.).
 *
 *       Useful for monitoring dashboards and alerting pipelines to detect
 *       when an external dependency is degraded without waiting for a full
 *       outage to surface in application logs.
 *     responses:
 *       200:
 *         description: All circuit breakers are CLOSED (healthy)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CircuitBreakerStatusResponse'
 *       206:
 *         description: One or more circuit breakers are OPEN or HALF-OPEN (degraded)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CircuitBreakerStatusResponse'
 */
router.get('/circuit-breakers', circuitBreakerController.getStatus.bind(circuitBreakerController));

export default router;
