import httpStatus from 'http-status-codes';
import { z } from 'zod';
import env from '../config/env';
import logger from '../config/logger';
import { DeliveryStatus, IDelivery } from '../models/Delivery';
import { DeliveryRepository, deliveryRepository } from '../repositories/DeliveryRepository';
import { CsvParseError, CsvRow, parseCsv } from '../utils/csvParser';
import { AppError } from '../utils/AppError';
import { NotificationService, notificationService } from './notificationService';

/**
 * Per-row schema for the bulk delivery CSV.
 *
 * Column names are lowercased by the parser, so they are declared lowercase
 * here. Numeric columns arrive as strings and are coerced.
 */
const deliveryRowSchema = z.object({
  trackingnumber: z.string().trim().min(1, 'trackingNumber is required'),
  customername: z.string().trim().min(1, 'customerName is required'),
  customerphone: z.string().trim().min(1, 'customerPhone is required'),
  customeremail: z
    .string()
    .trim()
    .email('customerEmail must be a valid email address')
    .optional()
    .or(z.literal('').transform(() => undefined)),
  pickupaddress: z.string().trim().min(1, 'pickupAddress is required'),
  dropoffaddress: z.string().trim().min(1, 'dropoffAddress is required'),
  packagedescription: z.string().trim().min(1, 'packageDescription is required'),
  packageweight: z.coerce
    .number({ message: 'packageWeight must be a number' })
    .positive('packageWeight must be greater than zero'),
  deliveryfee: z.coerce
    .number({ message: 'deliveryFee must be a number' })
    .nonnegative('deliveryFee cannot be negative'),
  escrowamount: z.coerce
    .number({ message: 'escrowAmount must be a number' })
    .nonnegative('escrowAmount cannot be negative'),
  notes: z
    .string()
    .trim()
    .optional()
    .or(z.literal('').transform(() => undefined)),
});

/** Columns that must be present in the CSV header. */
const REQUIRED_COLUMNS = [
  'trackingnumber',
  'customername',
  'customerphone',
  'pickupaddress',
  'dropoffaddress',
  'packagedescription',
  'packageweight',
  'deliveryfee',
  'escrowamount',
] as const;

/** A row that could not be imported, with the reason why. */
export interface BulkRowError {
  /** 1-based line number in the uploaded file. */
  line: number;
  /** Tracking number from the row, when it could be read. */
  trackingNumber?: string;
  /** Column the failure relates to, when attributable to one. */
  field?: string;
  message: string;
}

/** Outcome of a bulk import. */
export interface BulkImportResult {
  /** Data rows present in the file. */
  totalRows: number;
  /** Rows written to the database. */
  successCount: number;
  /**
   * Distinct rows rejected, by validation or by the database.
   *
   * Counts rows, not errors: one row can appear several times in `errors`
   * when more than one of its columns is invalid.
   */
  failureCount: number;
  /** Tracking numbers of the created deliveries. */
  created: string[];
  errors: BulkRowError[];
}

/**
 * Batch-creates deliveries from an uploaded CSV.
 *
 * Partial success is the expected outcome, not an error: a single bad row must
 * not discard the rest of a merchant's upload. Valid rows are inserted with an
 * unordered `insertMany` so the driver continues past individual failures, and
 * every rejected row is reported with its original line number.
 */
export class BulkDeliveryService {
  constructor(
    private readonly deliveries: DeliveryRepository = deliveryRepository,
    private readonly notifications: NotificationService = notificationService,
  ) {}

  /**
   * Parse, validate and insert deliveries from CSV content.
   *
   * @param csvContent - Raw CSV text from the uploaded file.
   * @param createdBy  - Id of the authenticated user performing the import.
   * @throws {AppError} 400 — the file itself is unusable (unparseable, empty,
   *                    missing required columns, or over the row limit).
   */
  async importFromCsv(csvContent: string, createdBy: string): Promise<BulkImportResult> {
    const parsed = this.parse(csvContent);
    this.assertRequiredColumns(parsed.headers);

    const { valid, errors } = this.validateRows(parsed.rows);

    // Reject in-file duplicates before touching the database — two rows with
    // the same tracking number would otherwise race, and which one won would
    // depend on insertion order.
    const deduped = this.rejectDuplicateTrackingNumbers(valid, errors);

    // One query resolves every collision with existing records, instead of an
    // existence check per row.
    const existing = await this.deliveries.findExistingTrackingNumbers(
      deduped.map((row) => row.data.trackingnumber),
    );

    const insertable = deduped.filter((row) => {
      if (existing.has(row.data.trackingnumber)) {
        errors.push({
          line: row.lineNumber,
          trackingNumber: row.data.trackingnumber,
          field: 'trackingNumber',
          message: 'A delivery with this tracking number already exists',
        });
        return false;
      }
      return true;
    });

    const created = await this.insert(insertable, createdBy, errors);

    // A single row can raise several errors (one per invalid column), so the
    // failure count is the number of distinct rejected lines — not the length
    // of the error list. Otherwise a one-row file with three bad fields would
    // report "3 of 1 rows failed".
    const failedLines = new Set(errors.map((error) => error.line));

    logger.info(
      `[BulkDeliveryService] Import finished — user=${createdBy} ` +
        `rows=${parsed.rows.length} created=${created.length} failed=${failedLines.size}`,
    );

    return {
      totalRows: parsed.rows.length,
      successCount: created.length,
      failureCount: failedLines.size,
      created: created.map((delivery) => delivery.trackingNumber ?? String(delivery._id)),
      // Line order makes the report easy to reconcile against the source file.
      errors: errors.sort((a, b) => a.line - b.line),
    };
  }

  /** Parse CSV text, translating parser failures into 400s. */
  private parse(csvContent: string): ReturnType<typeof parseCsv> {
    try {
      return parseCsv(csvContent, env.BULK_UPLOAD_MAX_ROWS);
    } catch (error) {
      if (error instanceof CsvParseError) {
        throw new AppError(error.message, httpStatus.BAD_REQUEST);
      }
      throw error;
    }
  }

  /** Fail fast when the header row is missing columns the import needs. */
  private assertRequiredColumns(headers: string[]): void {
    const missing = REQUIRED_COLUMNS.filter((column) => !headers.includes(column));

    if (missing.length > 0) {
      throw new AppError(
        `CSV is missing required column(s): ${missing.join(', ')}`,
        httpStatus.BAD_REQUEST,
      );
    }
  }

  /** Validate every row, collecting failures rather than aborting. */
  private validateRows(rows: CsvRow[]): {
    valid: Array<{ lineNumber: number; data: z.infer<typeof deliveryRowSchema> }>;
    errors: BulkRowError[];
  } {
    const valid: Array<{ lineNumber: number; data: z.infer<typeof deliveryRowSchema> }> = [];
    const errors: BulkRowError[] = [];

    for (const row of rows) {
      const result = deliveryRowSchema.safeParse(row.values);

      if (result.success) {
        valid.push({ lineNumber: row.lineNumber, data: result.data });
        continue;
      }

      // Report every field problem on the row so a merchant can fix the whole
      // line in one pass instead of resubmitting to find the next error.
      result.error.issues.forEach((issue) => {
        errors.push({
          line: row.lineNumber,
          trackingNumber: row.values.trackingnumber || undefined,
          field: issue.path.join('.') || undefined,
          message: issue.message,
        });
      });
    }

    return { valid, errors };
  }

  /** Drop rows whose tracking number repeats earlier in the same file. */
  private rejectDuplicateTrackingNumbers(
    rows: Array<{ lineNumber: number; data: z.infer<typeof deliveryRowSchema> }>,
    errors: BulkRowError[],
  ): Array<{ lineNumber: number; data: z.infer<typeof deliveryRowSchema> }> {
    const seen = new Map<string, number>();
    const unique: typeof rows = [];

    for (const row of rows) {
      const trackingNumber = row.data.trackingnumber;
      const firstSeen = seen.get(trackingNumber);

      if (firstSeen !== undefined) {
        errors.push({
          line: row.lineNumber,
          trackingNumber,
          field: 'trackingNumber',
          message: `Duplicate tracking number within the file (first seen on line ${firstSeen})`,
        });
        continue;
      }

      seen.set(trackingNumber, row.lineNumber);
      unique.push(row);
    }

    return unique;
  }

  /**
   * Insert the validated rows, tolerating per-document failures.
   *
   * `insertMany` with `ordered: false` continues past errors; on partial
   * failure Mongoose raises a `MongoBulkWriteError` carrying both the inserted
   * documents and the per-index write errors, which are mapped back to source
   * lines here.
   */
  private async insert(
    rows: Array<{ lineNumber: number; data: z.infer<typeof deliveryRowSchema> }>,
    createdBy: string,
    errors: BulkRowError[],
  ): Promise<IDelivery[]> {
    if (rows.length === 0) return [];

    const documents = rows.map((row) => this.toDeliveryDocument(row.data, createdBy));

    try {
      const inserted = await this.deliveries.createMany(documents, { ordered: false });
      await this.notifyCreated(inserted);
      return inserted;
    } catch (error) {
      const inserted = this.extractInsertedDocuments(error);
      const writeErrors = this.extractWriteErrors(error);

      if (writeErrors.length === 0) {
        // Not a partial-failure bulk error — the whole write failed.
        throw error;
      }

      writeErrors.forEach(({ index, message }) => {
        const row = rows[index];
        errors.push({
          line: row?.lineNumber ?? 0,
          trackingNumber: row?.data.trackingnumber,
          message: this.humaniseWriteError(message),
        });
      });

      await this.notifyCreated(inserted);
      return inserted;
    }
  }

  /**
   * Fire creation notifications for imported deliveries.
   *
   * Notification failures are swallowed by the notification service itself;
   * this extra guard keeps an unexpected throw from failing an import whose
   * rows are already committed.
   */
  private async notifyCreated(deliveries: IDelivery[]): Promise<void> {
    if (deliveries.length === 0) return;

    await Promise.all(
      deliveries.map(async (delivery) => {
        try {
          await this.notifications.notifyDeliveryTransition(delivery, DeliveryStatus.PENDING);
        } catch (error) {
          logger.error(
            `[BulkDeliveryService] Notification failed for delivery=${String(delivery._id)}`,
            error,
          );
        }
      }),
    );
  }

  /** Map a validated CSV row onto the Delivery document shape. */
  private toDeliveryDocument(
    row: z.infer<typeof deliveryRowSchema>,
    createdBy: string,
  ): Partial<IDelivery> {
    return {
      trackingNumber: row.trackingnumber,
      userId: createdBy,
      status: DeliveryStatus.PENDING,
      customer: {
        name: row.customername,
        phone: row.customerphone,
        ...(row.customeremail ? { email: row.customeremail } : {}),
      },
      pickup: { address: row.pickupaddress },
      dropoff: { address: row.dropoffaddress },
      package: {
        description: row.packagedescription,
        weight: row.packageweight,
      },
      deliveryFee: row.deliveryfee,
      escrowAmount: row.escrowamount,
      ...(row.notes ? { notes: row.notes } : {}),
    } as Partial<IDelivery>;
  }

  /** Pull successfully inserted documents out of a partial bulk-write failure. */
  private extractInsertedDocuments(error: unknown): IDelivery[] {
    const candidate = error as { insertedDocs?: IDelivery[] };
    return Array.isArray(candidate?.insertedDocs) ? candidate.insertedDocs : [];
  }

  /** Pull per-document write errors out of a partial bulk-write failure. */
  private extractWriteErrors(error: unknown): Array<{ index: number; message: string }> {
    const candidate = error as {
      writeErrors?: Array<{
        index?: number;
        err?: { index?: number; errmsg?: string };
        errmsg?: string;
      }>;
    };

    if (!Array.isArray(candidate?.writeErrors)) return [];

    return candidate.writeErrors.map((writeError) => ({
      index: writeError.index ?? writeError.err?.index ?? 0,
      message: writeError.errmsg ?? writeError.err?.errmsg ?? 'Database write failed',
    }));
  }

  /** Turn a raw driver error message into something a merchant can act on. */
  private humaniseWriteError(message: string): string {
    if (message.includes('E11000')) {
      return 'A delivery with this tracking number already exists';
    }
    return message;
  }
}

export const bulkDeliveryService = new BulkDeliveryService();
