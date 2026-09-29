import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

/** Stellar network aliases the backend can point at. */
export type StellarNetwork = 'mainnet' | 'testnet' | 'futurenet';

interface EnvConfig {
  NODE_ENV: string;
  PORT: number;
  APP_BASE_URL: string;
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
  UPLOAD_MAX_FILE_SIZE_MB: number;
  AWS_S3_BUCKET?: string;
  AWS_REGION?: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  AWS_S3_SIGNED_URL_EXPIRES_SECONDS: number;
  REDIS_URL: string;
  REDIS_LOCK_TTL_MS: number;
  REDIS_LOCK_RETRY_COUNT: number;
  REDIS_LOCK_RETRY_DELAY_MS: number;
  IDEMPOTENCY_TTL_SECONDS: number;
  PROFILE_PICTURE_MAX_SIZE_MB?: string;
  PROFILE_PICTURE_WIDTH?: string;
  PROFILE_PICTURE_HEIGHT?: string;
  PROFILE_PICTURE_QUALITY?: string;

  // ── Uploads / evidence storage ─────────────────────────────────────────────
  /** Public base URL used to build links to locally stored uploads. Default: http://localhost:3000 */
  APP_BASE_URL: string;
  /** Maximum accepted evidence upload size, in MB. Default: 10 */
  UPLOAD_MAX_FILE_SIZE_MB: number;
  /** AWS region for the S3 upload driver. Default: us-east-1 */
  AWS_REGION: string;
  /** AWS access key id. Blank falls back to the provider credential chain. */
  AWS_ACCESS_KEY_ID: string;
  /** AWS secret access key. Blank falls back to the provider credential chain. */
  AWS_SECRET_ACCESS_KEY: string;
  /** Lifetime (s) of S3 pre-signed download URLs. Default: 900 */
  AWS_S3_SIGNED_URL_EXPIRES_SECONDS: number;

  // ── Indexer lag monitoring ─────────────────────────────────────────────────
  /** Ledger gap at which an indexer-lag alert is raised. Default: 100 */
  INDEXER_LAG_ALERT_THRESHOLD: number;
  /** Interval (ms) between background indexer-lag checks. Default: 60000 */
  INDEXER_LAG_CHECK_INTERVAL_MS: number;
  /** Webhook notified when an indexer-lag alert fires. Blank disables the call. */
  INDEXER_LAG_WEBHOOK_URL: string;

  // ── Soroban RPC retry config ────────────────────────────────────────────────
  /** Maximum attempts (including the first) for generic RPC retries. Default: 3 */
  SOROBAN_RPC_MAX_RETRIES: number;
  /** Base delay (ms) for RPC exponential backoff. Default: 250 */
  SOROBAN_RPC_RETRY_BASE_MS: number;
  /** Maximum delay (ms) cap for RPC exponential backoff. Default: 8000 */
  SOROBAN_RPC_RETRY_MAX_MS: number;
  /** Maximum attempts to retry a transaction that fails with tx_bad_seq. Default: 3 */
  STELLAR_BAD_SEQ_MAX_RETRIES: number;

  // ── Soroban / Stellar connection ────────────────────────────────────────────
  STELLAR_NETWORK: StellarNetwork;
  /** Optional — falls back to the per-network default in `config/stellar.ts`. */
  SOROBAN_RPC_URL?: string;
  /** Optional — falls back to the SDK passphrase for `STELLAR_NETWORK`. */
  STELLAR_NETWORK_PASSPHRASE?: string;
  SOROBAN_RPC_TIMEOUT_MS: number;
  /** Optional at boot; endpoints that need it return 503. */
  SOROBAN_ESCROW_CONTRACT_ID?: string;
  SOROBAN_ESCROW_LOCK_FUNCTION: string;
  STELLAR_BASE_FEE: number;
  STELLAR_TRANSACTION_TIMEOUT_SECONDS: number;

  // ── Circuit breakers (Soroban RPC) ─────────────────────────────────────────
  /** Percentage of failures in the rolling window that opens the circuit. Default: 50 */
  CB_SOROBAN_ERROR_THRESHOLD_PERCENTAGE: number;
  /** Rolling statistics window (ms). Default: 30000 */
  CB_SOROBAN_ROLLING_WINDOW_MS: number;
  /** How long the circuit stays OPEN before a HALF-OPEN probe (ms). Default: 60000 */
  CB_SOROBAN_RESET_TIMEOUT_MS: number;
  /** Minimum calls in the window before the breaker may open. Default: 5 */
  CB_SOROBAN_VOLUME_THRESHOLD: number;
  /** Per-call timeout (ms). Default: 10000 */
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

  // ── Driver rating & penalties ─────────────────────────────────────
  /** Cron expression driving the driver-rating sweep. Default: hourly */
  DRIVER_RATING_CRON: string;

  // ── Proof of delivery ────────────────────────────────────────────
  /** Maximum accepted proof-of-delivery image size, in MB. Default: 8 */
  PROOF_OF_DELIVERY_MAX_SIZE_MB: number;
}

/**
 * Treat a blank environment value (`PORT=`) as unset.
 *
 * `z.coerce.number()` turns `''` into `0`, which would trip the `min()` bound
 * of every numeric field and abort startup even though the operator clearly
 * meant "use the default". Mapping blanks to `undefined` lets the schema
 * default apply instead.
 */
const blankToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

/**
 * Wrap a numeric schema so blank values fall back to the declared default.
 *
 * The `.default()` must live *inside* the wrapper: the preprocess turns a blank
 * into `undefined`, and only a `ZodDefault` on the receiving side will swap
 * that back out before `z.coerce.number()` turns it into `NaN`.
 */
const numeric = (schema: z.ZodType<number, unknown>): z.ZodType<number, unknown> =>
  z.preprocess(blankToUndefined, schema);

const envSchema = z.object({
  // ── Server ─────────────────────────────────────────────────────────────────
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: numeric(z.coerce.number().int().min(1).max(65535).default(3000)),
  APP_BASE_URL: z.string().trim().min(1).default('http://localhost:3000'),
  MONGODB_URI: z.string().trim().min(1).default('mongodb://localhost:27017/swiftchain'),

  // ── Auth / security ────────────────────────────────────────────────────────
  JWT_SECRET: z.string().min(16).default('change_me_in_prod_change_me'),
  JWT_EXPIRES_IN: z.string().trim().min(1).default('7d'),
  BCRYPT_ROUNDS: numeric(z.coerce.number().int().min(8).max(31).default(10)),
  CORS_ORIGIN: z.string().default('*'),
  RATE_LIMIT_WINDOW_MS: numeric(z.coerce.number().int().min(1000).default(900000)),
  RATE_LIMIT_MAX_REQUESTS: numeric(z.coerce.number().int().min(1).default(100)),
  DISPUTE_NOTIFICATION_WEBHOOK_URL: z.string().default(''),

  // ── Uploads / storage ──────────────────────────────────────────────────────
  UPLOAD_STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  UPLOAD_LOCAL_DIR: z.string().trim().min(1).default('uploads'),
  UPLOAD_MAX_FILE_SIZE_MB: numeric(z.coerce.number().positive().default(10)),
  AWS_S3_BUCKET: z.string().optional(),
  AWS_REGION: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_S3_SIGNED_URL_EXPIRES_SECONDS: numeric(z.coerce.number().int().min(1).default(3600)),

  // ── Redis ──────────────────────────────────────────────────────────────────
  REDIS_URL: z.string().default('redis://localhost:6379'),
  REDIS_LOCK_TTL_MS: numeric(z.coerce.number().int().min(1000).default(10000)),
  REDIS_LOCK_RETRY_COUNT: numeric(z.coerce.number().int().min(0).default(3)),
  REDIS_LOCK_RETRY_DELAY_MS: numeric(z.coerce.number().int().min(50).default(200)),

  // ── Idempotency ────────────────────────────────────────────────────────────
  IDEMPOTENCY_TTL_SECONDS: numeric(z.coerce.number().int().min(60).default(86400)),

  // ── Profile pictures ───────────────────────────────────────────────────────
  PROFILE_PICTURE_MAX_SIZE_MB: z.string().optional(),
  PROFILE_PICTURE_WIDTH: z.string().optional(),
  PROFILE_PICTURE_HEIGHT: z.string().optional(),
  PROFILE_PICTURE_QUALITY: z.string().optional(),

  // ── Soroban RPC retry config ───────────────────────────────────────────────
  SOROBAN_RPC_MAX_RETRIES: numeric(z.coerce.number().int().min(1).max(20).default(3)),
  SOROBAN_RPC_RETRY_BASE_MS: numeric(z.coerce.number().int().min(50).default(250)),
  SOROBAN_RPC_RETRY_MAX_MS: numeric(z.coerce.number().int().min(500).default(8000)),
  STELLAR_BAD_SEQ_MAX_RETRIES: numeric(z.coerce.number().int().min(1).max(10).default(3)),

  // ── Soroban / Stellar connection ───────────────────────────────────────────
  STELLAR_NETWORK: z.enum(['mainnet', 'testnet', 'futurenet']).default('testnet'),
  SOROBAN_RPC_URL: z.string().optional(),
  STELLAR_NETWORK_PASSPHRASE: z.string().optional(),
  SOROBAN_RPC_TIMEOUT_MS: numeric(z.coerce.number().int().min(1).default(10000)),
  SOROBAN_ESCROW_CONTRACT_ID: z.string().optional(),
  SOROBAN_ESCROW_LOCK_FUNCTION: z.string().trim().min(1).default('lock_escrow'),
  STELLAR_BASE_FEE: numeric(z.coerce.number().int().min(1).default(100)),
  STELLAR_TRANSACTION_TIMEOUT_SECONDS: numeric(z.coerce.number().int().min(1).default(300)),

  // ── Circuit breakers (Soroban RPC) ─────────────────────────────────────────
  CB_SOROBAN_ERROR_THRESHOLD_PERCENTAGE: numeric(z.coerce.number().min(1).max(100).default(50)),
  CB_SOROBAN_ROLLING_WINDOW_MS: numeric(z.coerce.number().int().min(1000).default(30000)),
  CB_SOROBAN_RESET_TIMEOUT_MS: numeric(z.coerce.number().int().min(1000).default(60000)),
  CB_SOROBAN_VOLUME_THRESHOLD: numeric(z.coerce.number().int().min(0).default(5)),
  CB_SOROBAN_TIMEOUT_MS: numeric(z.coerce.number().int().min(1).default(10000)),

  // ── ETA cache / routing ───────────────────────────────────────────────────
  ETA_CACHE_TTL_SECONDS: numeric(z.coerce.number().int().min(1).default(600)),
  ETA_GEOHASH_PRECISION: numeric(z.coerce.number().int().min(1).max(12).default(7)),
  GOOGLE_MAPS_API_KEY: z.string().optional(),

  // ── Indexer lag monitor ────────────────────────────────────────────────────
  INDEXER_LAG_WEBHOOK_URL: z.string().default(''),
  INDEXER_LAG_ALERT_THRESHOLD: numeric(z.coerce.number().int().min(1).default(100)),
  INDEXER_LAG_CHECK_INTERVAL_MS: numeric(z.coerce.number().int().min(1000).default(60000)),

  // ── Escrow indexer ─────────────────────────────────────────────────────────
  ESCROW_CONTRACT_ID: z.string().trim().default(''),
  ESCROW_FUNDED_EVENT_TOPIC: z.string().trim().min(1).default('escrow_funded'),
  ESCROW_MONITOR_CRON: z.string().trim().min(1).default('*/5 * * * *'),

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

  // ── Driver rating & penalties ─────────────────────────────────────
  DRIVER_RATING_CRON: z.string().trim().min(1).default('0 * * * *'),

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
  console.error('❌ DRIVER_PROXIMITY_DEFAULT_RADIUS_M cannot exceed DRIVER_PROXIMITY_MAX_RADIUS_M');
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
