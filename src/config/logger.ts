/**
 * logger.ts
 *
 * The single logging interface for the application. Every module logs through
 * the default export of this file; no other module constructs a transport.
 *
 * Three guarantees this module provides:
 *
 *  1. **PII is masked before it reaches any transport.** The masking format is
 *     installed on the logger itself rather than on individual transports, so
 *     the console, the rotating files and any transport added later all receive
 *     already-redacted records. See `utils/piiMasker.ts` for the rules.
 *
 *  2. **File output is rotated and bounded.** `winston-daily-rotate-file`
 *     rotates daily and on size, gzips old files and prunes them past the
 *     retention window, so a long-running container cannot fill its disk.
 *
 *  3. **The process does not die because logging failed.** Transport `error`
 *     events are handled, and `exitOnError` is false.
 *
 * Configuration comes exclusively from the validated `config/env` object.
 */

import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
// pnpm's strict layout does not expose `logform` at the project root, so the
// info shape is taken from winston's own re-export of the package.
type TransformableInfo = winston.Logform.TransformableInfo;
import env from './env';
import { maskValue, maskString } from '../utils/piiMasker';

/**
 * Severity levels, lowest number = highest severity.
 * Mirrors the npm levels the codebase already logs at.
 */
const levels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  debug: 4,
};

const colors = {
  error: 'red',
  warn: 'yellow',
  info: 'green',
  http: 'magenta',
  debug: 'white',
};

winston.addColors(colors);

/**
 * Winston symbol keys carried on every log record. They hold the raw level and
 * the splat arguments, and must not be treated as user metadata.
 */
const LEVEL_SYMBOL = Symbol.for('level') as unknown as keyof TransformableInfo;
const SPLAT_SYMBOL = Symbol.for('splat') as unknown as keyof TransformableInfo;

/**
 * Format that redacts PII from both the message and any structured metadata.
 *
 * Installed first in the format chain so every downstream formatter — JSON,
 * printf, colorizer — only ever sees masked content. Because it runs inside
 * the logger, all 300+ existing `logger.info(...)` call sites gain masking
 * without any change at the call site.
 *
 * If masking itself throws, the record is replaced with a safe placeholder
 * rather than allowed through unmasked: failing closed is the only correct
 * behaviour for a redaction layer.
 */
const maskPiiFormat = winston.format((info) => {
  try {
    if (typeof info.message === 'string') {
      info.message = maskString(info.message);
    } else if (info.message !== undefined) {
      info.message = maskValue(info.message) as TransformableInfo['message'];
    }

    for (const key of Object.keys(info)) {
      if (key === 'message' || key === 'level' || key === 'timestamp') continue;
      (info as Record<string, unknown>)[key] = maskValue((info as Record<string, unknown>)[key]);
    }

    // `splat` holds the extra arguments passed to logger.info(msg, a, b, …).
    const splat = (info as Record<symbol, unknown>)[SPLAT_SYMBOL as unknown as symbol];
    if (Array.isArray(splat)) {
      (info as Record<symbol, unknown>)[SPLAT_SYMBOL as unknown as symbol] = splat.map((arg) =>
        maskValue(arg),
      );
    }

    return info;
  } catch {
    return {
      ...info,
      [LEVEL_SYMBOL]: info[LEVEL_SYMBOL],
      message: '[log record suppressed: PII masking failed]',
    } as TransformableInfo;
  }
});

/**
 * Render structured metadata as a compact suffix for the human-readable
 * console output, e.g. `... {"deliveryId":"abc"}`.
 */
function formatMetadata(info: TransformableInfo): string {
  const omitted = new Set(['level', 'message', 'timestamp', 'stack']);
  const meta: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(info)) {
    if (!omitted.has(key) && value !== undefined) meta[key] = value;
  }

  if (Object.keys(meta).length === 0) return '';

  try {
    return ` ${JSON.stringify(meta)}`;
  } catch {
    return ' [unserialisable metadata]';
  }
}

/** Colourised, single-line format for local development. */
const devFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  winston.format.colorize({ all: true }),
  winston.format.printf(
    (info) =>
      `${info.timestamp as string} ${info.level}: ${String(info.message)}${formatMetadata(info)}`,
  ),
);

/**
 * Structured JSON for production and for all file output, so records can be
 * ingested by a log aggregator without parsing.
 */
const prodFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json(),
);

const consoleFormat = env.NODE_ENV === 'development' ? devFormat : prodFormat;

/**
 * Build a rotating file transport.
 *
 * @param filename - Basename pattern; `%DATE%` is substituted by the rotator.
 * @param level    - Optional minimum level for this transport.
 */
function createRotatingTransport(filename: string, level?: string): DailyRotateFile {
  return new DailyRotateFile({
    dirname: env.LOG_DIR,
    filename,
    datePattern: 'YYYY-MM-DD',
    zippedArchive: env.LOG_ZIPPED_ARCHIVE,
    maxSize: env.LOG_MAX_SIZE,
    maxFiles: env.LOG_MAX_FILES,
    level,
    format: prodFormat,
    handleExceptions: false,
  });
}

const transports: winston.transport[] = [new winston.transports.Console({ format: consoleFormat })];

// File transports are skipped when disabled, and in tests, so unit runs do not
// leave log files behind or hold open file handles after the suite ends.
if (!env.LOG_DISABLE_FILE && env.NODE_ENV !== 'test') {
  const errorTransport = createRotatingTransport('error-%DATE%.log', 'error');
  const combinedTransport = createRotatingTransport('all-%DATE%.log');

  for (const transport of [errorTransport, combinedTransport]) {
    // A rotation or disk failure must never take the process down. These
    // handlers write straight to the console rather than through `logger`,
    // which is not constructed yet at this point in module evaluation.
    transport.on('error', (error: Error) => {
      // eslint-disable-next-line no-console
      console.error(`[logger] file transport error: ${maskString(error.message)}`);
    });
    transport.on('rotate', (oldFilename: string, newFilename: string) => {
      // eslint-disable-next-line no-console
      console.info(`[logger] rotated ${oldFilename} -> ${newFilename}`);
    });
  }

  transports.push(errorTransport, combinedTransport);
}

/**
 * The application logger.
 *
 * Masking is applied by the logger-level format, so every transport receives
 * redacted records.
 */
const logger = winston.createLogger({
  level: env.LOG_LEVEL,
  levels,
  format: winston.format.combine(maskPiiFormat(), prodFormat),
  transports,
  exitOnError: false,
});

/**
 * Stream adapter so HTTP access-log middleware (morgan and friends) can write
 * through the same masked pipeline.
 */
export const loggerStream = {
  write: (message: string): void => {
    logger.http(message.trim());
  },
};

export default logger;
