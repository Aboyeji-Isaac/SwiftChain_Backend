/**
 * Health check type definitions for GET /api/v1/health.
 *
 * These types are shared between the service layer and the controller layer
 * so both speak the same contract without requiring runtime casting.
 */

/** Per-service health state. */
export type ServiceStatus = 'healthy' | 'unhealthy';

/** Aggregate health state — healthy only when ALL required services are healthy. */
export type OverallStatus = 'healthy' | 'degraded';

/**
 * MongoDB connectivity details returned by the health service.
 */
export interface MongoDbHealth {
  /** Whether the database is reachable and accepting queries. */
  status: ServiceStatus;
  /**
   * Raw Mongoose connection readyState for diagnostic purposes.
   * 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting.
   */
  readyState: number;
  /** Human-readable label derived from readyState (e.g. "connected"). */
  readyStateLabel: string;
  /** Present only when status is "unhealthy". Never contains credentials. */
  error?: string;
}

/**
 * Stellar / Soroban RPC connectivity details returned by the health service.
 */
export interface StellarRpcHealth {
  /** Whether the Soroban RPC node is reachable and responded successfully. */
  status: ServiceStatus;
  /** Stellar network alias, e.g. "testnet". Present on success. */
  network?: string;
  /** Latest ledger sequence number. Present on success. */
  latestLedger?: number;
  /** Round-trip latency in milliseconds. Present on success. */
  latencyMs?: number;
  /** ISO-8601 timestamp of when the check was performed. */
  checkedAt: string;
  /** Present only when status is "unhealthy". Never contains credentials or RPC URLs. */
  error?: string;
}

/**
 * Top-level result returned by HealthService and serialised by the controller.
 */
export interface HealthCheckResult {
  /** Aggregate status — "healthy" only when ALL services are healthy. */
  status: OverallStatus;
  /** Per-service health breakdown. */
  services: {
    mongodb: MongoDbHealth;
    stellarRpc: StellarRpcHealth;
  };
  /** ISO-8601 timestamp of when this check ran. */
  timestamp: string;
  /** Process uptime in seconds at the time of the check. */
  uptime: number;
}
