import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import env from '../config/env';
import logger from '../config/logger';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface StoredObject {
  /** Backend-specific object key (S3 key or local relative path). */
  key: string;
  /** Secure URL clients use to retrieve the file. */
  url: string;
}

export interface StorageDriver {
  /** Persist `buffer` under a unique key derived from `originalName` and return its URL. */
  upload(buffer: Buffer, originalName: string, mimeType: string): Promise<StoredObject>;
}

// ─── Local disk driver ─────────────────────────────────────────────────────────

/**
 * Persists uploads to a local directory on disk and serves them back via the
 * `/uploads` static route mounted in `app.ts`.
 *
 * Suitable for local development and single-instance deployments. Use the S3
 * driver for anything horizontally scaled or requiring durable storage.
 */
export class LocalStorageDriver implements StorageDriver {
  private readonly uploadDir: string;

  constructor(uploadDir: string = env.UPLOAD_LOCAL_DIR) {
    this.uploadDir = uploadDir;
  }

  public async upload(
    buffer: Buffer,
    originalName: string,
    _mimeType: string,
  ): Promise<StoredObject> {
    const key = buildObjectKey(originalName);
    const absolutePath = path.join(process.cwd(), this.uploadDir, key);

    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, buffer);

    const url = `${env.APP_BASE_URL.replace(/\/$/, '')}/uploads/${key}`;

    logger.debug(`[Storage] Local upload written — key=${key}`);

    return { key, url };
  }
}

// ─── S3 driver ─────────────────────────────────────────────────────────────────

/**
 * Persists uploads to an AWS S3 bucket and returns a time-limited signed URL
 * so evidence files are not publicly readable by default.
 */
export class S3StorageDriver implements StorageDriver {
  private readonly client: S3Client;

  constructor(client?: S3Client) {
    this.client =
      client ??
      new S3Client({
        region: env.AWS_REGION,
        credentials:
          env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
            ? {
                accessKeyId: env.AWS_ACCESS_KEY_ID,
                secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
              }
            : undefined,
      });
  }

  public async upload(
    buffer: Buffer,
    originalName: string,
    mimeType: string,
  ): Promise<StoredObject> {
    const key = buildObjectKey(originalName);

    await this.client.send(
      new PutObjectCommand({
        Bucket: env.AWS_S3_BUCKET,
        Key: key,
        Body: buffer,
        ContentType: mimeType,
      }),
    );

    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: env.AWS_S3_BUCKET, Key: key }),
      { expiresIn: env.AWS_S3_SIGNED_URL_EXPIRES_SECONDS },
    );

    logger.debug(`[Storage] S3 upload written — bucket=${env.AWS_S3_BUCKET} key=${key}`);

    return { key, url };
  }
}

// ─── Shared helpers ──────────────────────────────────────────────────────────

/** Build a unique, collision-resistant object key that preserves the file extension. */
function buildObjectKey(originalName: string): string {
  const ext = path.extname(originalName).toLowerCase();
  const unique = `${Date.now()}-${crypto.randomUUID()}`;

  // If originalName already has a path (like profiles/userId/...), use it as-is
  // Otherwise, default to evidence/ prefix for backward compatibility
  if (originalName.includes('/')) {
    return originalName;
  }

  return `evidence/${unique}${ext}`;
}

// ─── Factory ───────────────────────────────────────────────────────────────────

let cachedDriver: StorageDriver | null = null;

/**
 * Resolve the active storage driver based on `UPLOAD_STORAGE_DRIVER`.
 * Cached after first resolution since the driver is stateless per config.
 */
export function getStorageDriver(): StorageDriver {
  if (cachedDriver) {
    return cachedDriver;
  }

  cachedDriver =
    env.UPLOAD_STORAGE_DRIVER === 's3' ? new S3StorageDriver() : new LocalStorageDriver();
  return cachedDriver;
}

/** Test-only hook to reset the cached driver between test suites. */
export function resetStorageDriverCache(): void {
  cachedDriver = null;
}
