import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

interface EnvConfig {
  NODE_ENV: string;
  PORT: number;
  MONGODB_URI: string;
  JWT_SECRET: string;
  JWT_EXPIRES_IN: string;
  BCRYPT_ROUNDS: number;
  LOG_LEVEL: string;
  CORS_ORIGIN: string;
  RATE_LIMIT_WINDOW_MS: number;
  RATE_LIMIT_MAX_REQUESTS: number;
  DISPUTE_NOTIFICATION_WEBHOOK_URL: string;
  UPLOAD_STORAGE_DRIVER: string;
  UPLOAD_LOCAL_DIR: string;
  AWS_S3_BUCKET?: string;
  REDIS_URL: string;
  REDIS_LOCK_TTL_MS: number;
  REDIS_LOCK_RETRY_COUNT: number;
  REDIS_LOCK_RETRY_DELAY_MS: number;
  IDEMPOTENCY_TTL_SECONDS: number;
  PROFILE_PICTURE_MAX_SIZE_MB?: string;
  PROFILE_PICTURE_WIDTH?: string;
  PROFILE_PICTURE_HEIGHT?: string;
  PROFILE_PICTURE_QUALITY?: string;

  // ── Soroban RPC retry config ────────────────────────────────────────────────
  /** Maximum attempts (including the first) for generic RPC retries. Default: 3 */
  SOROBAN_RPC_MAX_RETRIES: number;
  /** Base delay (ms) for RPC exponential backoff. Default: 250 */
  SOROBAN_RPC_RETRY_BASE_MS: number;
  /** Maximum delay (ms) cap for RPC exponential backoff. Default: 8000 */
  SOROBAN_RPC_RETRY_MAX_MS: number;
  /** Maximum attempts to retry a transaction that fails with tx_bad_seq. Default: 3 */
  STELLAR_BAD_SEQ_MAX_RETRIES: number;

  // ── Push notifications (Firebase Cloud Messaging) ───────────────────────────
  /**
   * Firebase project id. Push sending is disabled when this (or either
   * credential below) is blank, so local development runs without Firebase.
   */
  FCM_PROJECT_ID: string;
  /** Service-account client email used to mint OAuth2 access tokens. */
  FCM_CLIENT_EMAIL: string;
  /** Service-account private key (PEM; literal `\n` sequences are normalised). */
  FCM_PRIVATE_KEY: string;
  /** Timeout (ms) for FCM and Google token endpoint requests. Default: 10000 */
  FCM_REQUEST_TIMEOUT_MS: number;

  // ── Bulk delivery CSV import ────────────────────────────────────────────────
  /** Maximum accepted upload size (bytes) for the bulk CSV endpoint. Default: 5MB */
  BULK_UPLOAD_MAX_BYTES: number;
  /** Maximum data rows accepted in a single bulk upload. Default: 1000 */
  BULK_UPLOAD_MAX_ROWS: number;

  // ── Socket.IO transport tuning ────────────────────────────────────
  /** Interval (ms) between server-initiated Socket.IO pings. Default: 25000 */
  SOCKET_PING_INTERVAL_MS: number;
  /** Time (ms) to wait for a pong before considering the peer gone. Default: 20000 */
  SOCKET_PING_TIMEOUT_MS: number;
  /** Consecutive missed pongs tolerated before disconnecting. Default: 2 */
  SOCKET_MAX_MISSED_PONGS: number;
  /** Time (ms) a queued socket message waits for an ack before retry. Default: 15000 */
  SOCKET_MESSAGE_ACK_TIMEOUT_MS: number;
  /** Interval (ms) between periodic socket token expiry checks. Default: 60000 */
  SOCKET_TOKEN_CHECK_INTERVAL_MS: number;
  /** Grace period (ms) granted after a socket token expires. Default: 30000 */
  SOCKET_TOKEN_GRACE_PERIOD_MS: number;
  /** Maximum location updates accepted in a single offline-sync batch. Default: 500 */
  SYNC_BATCH_SIZE_LIMIT: number;

  // ── Driver location ingestion ─────────────────────────────────
  /** TTL (s) of the Redis dedup key for a location update. Default: 60 */
  LOCATION_DEDUP_TTL_SECONDS: number;
  /** Maximum age (ms) of a location update before it is rejected. Default: 300000 */
  LOCATION_MAX_AGE_MS: number;
  /** Clock-skew tolerance (ms) for future-dated location updates. Default: 30000 */
  LOCATION_MAX_FUTURE_MS: number;
  /** Default radius (m) used by driver proximity searches. Default: 5000 */
  DRIVER_PROXIMITY_DEFAULT_RADIUS_M: number;
  /** Hard cap (m) on the radius a proximity search may request. Default: 50000 */
  DRIVER_PROXIMITY_MAX_RADIUS_M: number;
  /** Maximum number of drivers returned by a proximity search. Default: 50 */
  DRIVER_PROXIMITY_MAX_RESULTS: number;
  /** Age (s) beyond which a driver location is considered stale. Default: 300 */
  DRIVER_LOCATION_STALE_AFTER_SECONDS: number;

  // ── ETA cache / routing ──────────────────────────────────────
  /** TTL (s) for cached ETA computations. Default: 600 */
  ETA_CACHE_TTL_SECONDS: number;
  /** Geohash precision used to key the ETA cache. Default: 7 */
  ETA_GEOHASH_PRECISION: number;
  /** Google Maps Directions API key. Blank disables live routing. */
  GOOGLE_MAPS_API_KEY: string;

  // ── Lifecycle / jobs ──────────────────────────────────────────
  /** Time (ms) allowed for in-flight work to drain on shutdown. Default: 30000 */
  SHUTDOWN_TIMEOUT_MS: number;
  /** Cron expression driving the escrow monitor job. Default: every 5 minutes */
  ESCROW_MONITOR_CRON: string;
  /** Lock TTL (s) after which a still-locked escrow is flagged as expired. Default: 86400 (24h) */
  ESCROW_LOCK_TTL_SECONDS: number;

  // ── Stellar / Soroban network ─────────────────────────────────
  /** Target Stellar network. Default: testnet */
  STELLAR_NETWORK: 'mainnet' | 'testnet' | 'futurenet';
  /** Soroban RPC endpoint. Blank resolves to the default URL for the network. */
  SOROBAN_RPC_URL: string;
  /** Network passphrase. Blank resolves to the well-known value for the network. */
  STELLAR_NETWORK_PASSPHRASE: string;
  /** Per-request HTTP timeout (ms) for Soroban RPC calls. Default: 10000 */
  SOROBAN_RPC_TIMEOUT_MS: number;
  /** Soroban contract id (`C...`) of the escrow contract. Blank disables escrow endpoints. */
  SOROBAN_ESCROW_CONTRACT_ID: string;
  /** Escrow contract function invoked to lock funds. Default: lock_escrow */
  SOROBAN_ESCROW_LOCK_FUNCTION: string;
  /** Base fee (stroops) used when building transactions. Default: 100 */
  STELLAR_BASE_FEE: string;
  /** Validity window (s) of generated unsigned transactions. Default: 300 */
  STELLAR_TRANSACTION_TIMEOUT_SECONDS: number;
  /** Jitter ratio (0-1) applied to RPC backoff delays. Default: 0.2 */
  SOROBAN_RPC_RETRY_JITTER_RATIO: number;

  // ── Escrow event indexing ───────────────────────────────────
  /** Contract id watched by the escrow event indexer. */
  ESCROW_CONTRACT_ID: string;
  /** Event topic signalling that an escrow was funded. Default: escrow_funded */
  ESCROW_FUNDED_EVENT_TOPIC: string;

  // ── Logging ───────────────────────────────────────────────────
  /** Directory that rotated log files are written to. Default: logs */
  LOG_DIR: string;
  /** Maximum size of a single log file before rotation (e.g. "20m"). */
  LOG_MAX_SIZE: string;
  /** Retention window for rotated log files (e.g. "14d"). */
  LOG_MAX_FILES: string;
  /** Whether rotated log files are gzipped. Default: true */
  LOG_ZIPPED_ARCHIVE: boolean;
  /** Disable file transports entirely (useful in containers). Default: false */
  LOG_DISABLE_FILE: boolean;

  // ── Soroban circuit breaker ───────────────────────────────────
  /** Error rate (%) at which the Soroban breaker opens. Default: 50 */
  CB_SOROBAN_ERROR_THRESHOLD_PERCENTAGE: number;
  /** Window (ms) over which the breaker's error rate is measured. Default: 10000 */
  CB_SOROBAN_ROLLING_WINDOW_MS: number;
  /** Time (ms) the breaker stays open before probing again. Default: 30000 */
  CB_SOROBAN_RESET_TIMEOUT_MS: number;
  /** Minimum calls in the window before the breaker may open. Default: 5 */
  CB_SOROBAN_VOLUME_THRESHOLD: number;
  /** Per-call timeout (ms) enforced by the breaker. Default: 10000 */
  CB_SOROBAN_TIMEOUT_MS: number;

  // ── Merchant webhooks ───────────────────────────────────────────
  /** Per-request timeout (ms) for a webhook POST. Default: 10000 */
  WEBHOOK_REQUEST_TIMEOUT_MS: number;
  /** Maximum delivery attempts (including the first) before an attempt is exhausted. Default: 5 */
  WEBHOOK_MAX_RETRIES: number;
  /** Base delay (ms) for webhook retry exponential backoff. Default: 30000 */
  WEBHOOK_RETRY_BASE_MS: number;
  /** Maximum delay (ms) cap for webhook retry exponential backoff. Default: 3600000 */
  WEBHOOK_RETRY_MAX_MS: number;
  /** Cron expression driving the webhook retry sweep. Default: every minute */
  WEBHOOK_RETRY_CRON: string;
  /** Maximum due attempts processed per retry sweep tick. Default: 50 */
  WEBHOOK_RETRY_BATCH_SIZE: number;

  // ── Driver assignment ────────────────────────────────────────────
  /** Number of times the search radius doubles before giving up. Default: 3 */
  ASSIGNMENT_RADIUS_EXPANSION_STEPS: number;
  /** Cron expression driving the auto-assignment sweep for unassigned funded deliveries. Default: every minute */
  AUTO_ASSIGNMENT_CRON: string;

  // ── Proof of delivery ────────────────────────────────────────────
  /** Maximum accepted proof-of-delivery image size, in MB. Default: 8 */
  PROOF_OF_DELIVERY_MAX_SIZE_MB: number;
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  MONGODB_URI: z.string().default('mongodb://localhost:27017/swiftchain'),
  JWT_SECRET: z.string().min(16).default('change_me_in_prod_change_me'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(8).max(31).default(10),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly']).default('info'),
  CORS_ORIGIN: z.string().default('*'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(900000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().min(1).default(100),
  DISPUTE_NOTIFICATION_WEBHOOK_URL: z.string().default(''),
  UPLOAD_STORAGE_DRIVER: z.string().default('local'),
  UPLOAD_LOCAL_DIR: z.string().default('uploads'),
  AWS_S3_BUCKET: z.string().optional(),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  REDIS_LOCK_TTL_MS: z.coerce.number().int().min(1000).default(10000),
  REDIS_LOCK_RETRY_COUNT: z.coerce.number().int().min(0).default(3),
  REDIS_LOCK_RETRY_DELAY_MS: z.coerce.number().int().min(50).default(200),
  IDEMPOTENCY_TTL_SECONDS: z.coerce.number().int().min(60).default(86400),
  PROFILE_PICTURE_MAX_SIZE_MB: z.string().optional(),
  PROFILE_PICTURE_WIDTH: z.string().optional(),
  PROFILE_PICTURE_HEIGHT: z.string().optional(),
  PROFILE_PICTURE_QUALITY: z.string().optional(),

  // ── Soroban RPC retry config ────────────────────────────────────────────────
  SOROBAN_RPC_MAX_RETRIES: z.coerce.number().int().min(1).max(20).default(3),
  SOROBAN_RPC_RETRY_BASE_MS: z.coerce.number().int().min(50).default(250),
  SOROBAN_RPC_RETRY_MAX_MS: z.coerce.number().int().min(500).default(8000),
  STELLAR_BAD_SEQ_MAX_RETRIES: z.coerce.number().int().min(1).max(10).default(3),

  // ── Push notifications (Firebase Cloud Messaging) ───────────────────────────
  FCM_PROJECT_ID: z.string().default(''),
  FCM_CLIENT_EMAIL: z.string().default(''),
  FCM_PRIVATE_KEY: z.string().default(''),
  FCM_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).default(10000),

  // ── Bulk delivery CSV import ────────────────────────────────────────────────
  BULK_UPLOAD_MAX_BYTES: z.coerce.number().int().min(1024).default(5 * 1024 * 1024),
  BULK_UPLOAD_MAX_ROWS: z.coerce.number().int().min(1).max(10000).default(1000),

  // ── Socket.IO transport tuning ────────────────────────────────────
  SOCKET_PING_INTERVAL_MS: z.coerce.number().int().min(1000).default(25000),
  SOCKET_PING_TIMEOUT_MS: z.coerce.number().int().min(1000).default(20000),
  SOCKET_MAX_MISSED_PONGS: z.coerce.number().int().min(1).max(10).default(2),
  SOCKET_MESSAGE_ACK_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15000),
  SOCKET_TOKEN_CHECK_INTERVAL_MS: z.coerce.number().int().min(1000).default(60000),
  SOCKET_TOKEN_GRACE_PERIOD_MS: z.coerce.number().int().min(0).default(30000),
  SYNC_BATCH_SIZE_LIMIT: z.coerce.number().int().min(1).max(10000).default(500),

  // ── Driver location ingestion ─────────────────────────────────
  LOCATION_DEDUP_TTL_SECONDS: z.coerce.number().int().min(1).default(60),
  LOCATION_MAX_AGE_MS: z.coerce.number().int().min(1000).default(300000),
  LOCATION_MAX_FUTURE_MS: z.coerce.number().int().min(0).default(30000),
  DRIVER_PROXIMITY_DEFAULT_RADIUS_M: z.coerce.number().int().min(1).default(5000),
  DRIVER_PROXIMITY_MAX_RADIUS_M: z.coerce.number().int().min(1).default(50000),
  DRIVER_PROXIMITY_MAX_RESULTS: z.coerce.number().int().min(1).max(500).default(50),
  DRIVER_LOCATION_STALE_AFTER_SECONDS: z.coerce.number().int().min(1).default(300),

  // ── ETA cache / routing ──────────────────────────────────────
  ETA_CACHE_TTL_SECONDS: z.coerce.number().int().min(1).default(600),
  ETA_GEOHASH_PRECISION: z.coerce.number().int().min(1).max(12).default(7),
  GOOGLE_MAPS_API_KEY: z.string().default(''),

  // ── Lifecycle / jobs ──────────────────────────────────────────
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30000),
  ESCROW_MONITOR_CRON: z.string().trim().min(1).default('*/5 * * * *'),
  ESCROW_LOCK_TTL_SECONDS: z.coerce.number().int().min(1).default(86400),

  // ── Stellar / Soroban network ─────────────────────────────────
  STELLAR_NETWORK: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.enum(['mainnet', 'testnet', 'futurenet']))
    .default('testnet'),
  SOROBAN_RPC_URL: z.string().trim().default(''),
  STELLAR_NETWORK_PASSPHRASE: z.string().trim().default(''),
  SOROBAN_RPC_TIMEOUT_MS: z.coerce.number().int().min(1000).default(10000),
  SOROBAN_ESCROW_CONTRACT_ID: z.string().trim().default(''),
  SOROBAN_ESCROW_LOCK_FUNCTION: z.string().trim().min(1).default('lock_escrow'),
  STELLAR_BASE_FEE: z.string().trim().min(1).default('100'),
  STELLAR_TRANSACTION_TIMEOUT_SECONDS: z.coerce.number().int().min(1).default(300),
  SOROBAN_RPC_RETRY_JITTER_RATIO: z.coerce.number().min(0).max(1).default(0.2),

  // ── Escrow event indexing ───────────────────────────────────
  ESCROW_CONTRACT_ID: z.string().trim().default(''),
  ESCROW_FUNDED_EVENT_TOPIC: z.string().trim().min(1).default('escrow_funded'),

  // ── Logging ───────────────────────────────────────────────────
  LOG_DIR: z.string().trim().min(1).default('logs'),
  LOG_MAX_SIZE: z.string().trim().min(1).default('20m'),
  LOG_MAX_FILES: z.string().trim().min(1).default('14d'),
  LOG_ZIPPED_ARCHIVE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  LOG_DISABLE_FILE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  // ── Soroban circuit breaker ───────────────────────────────────
  CB_SOROBAN_ERROR_THRESHOLD_PERCENTAGE: z.coerce.number().int().min(1).max(100).default(50),
  CB_SOROBAN_ROLLING_WINDOW_MS: z.coerce.number().int().min(1000).default(10000),
  CB_SOROBAN_RESET_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30000),
  CB_SOROBAN_VOLUME_THRESHOLD: z.coerce.number().int().min(1).default(5),
  CB_SOROBAN_TIMEOUT_MS: z.coerce.number().int().min(1000).default(10000),

  // ── Merchant webhooks ───────────────────────────────────────────
  WEBHOOK_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).default(10000),
  WEBHOOK_MAX_RETRIES: z.coerce.number().int().min(1).max(20).default(5),
  WEBHOOK_RETRY_BASE_MS: z.coerce.number().int().min(1000).default(30000),
  WEBHOOK_RETRY_MAX_MS: z.coerce.number().int().min(1000).default(3600000),
  WEBHOOK_RETRY_CRON: z.string().trim().min(1).default('* * * * *'),
  WEBHOOK_RETRY_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),

  // ── Driver assignment ────────────────────────────────────────────
  ASSIGNMENT_RADIUS_EXPANSION_STEPS: z.coerce.number().int().min(0).max(10).default(3),
  AUTO_ASSIGNMENT_CRON: z.string().trim().min(1).default('* * * * *'),

  // ── Proof of delivery ────────────────────────────────────────────
  PROOF_OF_DELIVERY_MAX_SIZE_MB: z.coerce.number().int().min(1).default(8),
});

let env: EnvConfig;

try {
  env = envSchema.parse(process.env);
} catch (error) {
  if (error instanceof z.ZodError) {
    console.error('❌ Invalid environment variables:');
    error.issues.forEach((issue) => {
      console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
    });
  } else {
    console.error('❌ Failed to parse environment variables:', error);
  }
  process.exit(1);
}

if (env.UPLOAD_STORAGE_DRIVER === 's3' && !env.AWS_S3_BUCKET) {
  console.error('❌ AWS_S3_BUCKET is required when UPLOAD_STORAGE_DRIVER=s3');
  process.exit(1);
}

if (env.DRIVER_PROXIMITY_DEFAULT_RADIUS_M > env.DRIVER_PROXIMITY_MAX_RADIUS_M) {
  console.error(
    '❌ DRIVER_PROXIMITY_DEFAULT_RADIUS_M cannot exceed DRIVER_PROXIMITY_MAX_RADIUS_M',
  );
  process.exit(1);
}

if (env.SOROBAN_RPC_RETRY_BASE_MS > env.SOROBAN_RPC_RETRY_MAX_MS) {
  console.error('❌ SOROBAN_RPC_RETRY_BASE_MS cannot exceed SOROBAN_RPC_RETRY_MAX_MS');
  process.exit(1);
}

if (env.WEBHOOK_RETRY_BASE_MS > env.WEBHOOK_RETRY_MAX_MS) {
  console.error('❌ WEBHOOK_RETRY_BASE_MS cannot exceed WEBHOOK_RETRY_MAX_MS');
  process.exit(1);
}

export default env;
