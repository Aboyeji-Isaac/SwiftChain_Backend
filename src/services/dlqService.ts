import { DlqEntry, IDlqEntry, DlqStatus } from '../models/DlqEntry';
import AppError from '../utils/AppError';
import { StatusCodes } from 'http-status-codes';

// We import stellarService inside the function to avoid circular dependencies
// since stellarService will import dlqService.
export class DlqService {
  /**
   * Add a failed transaction to the Dead Letter Queue.
   */
  public async addEntry(payload: any, errorReason: string): Promise<IDlqEntry> {
    const entry = new DlqEntry({
      payload,
      errorReason,
      status: DlqStatus.PENDING,
      retryCount: 0,
    });
    return await entry.save();
  }

  /**
   * List DLQ entries with pagination.
   */
  public async listEntries(
    page: number = 1,
    limit: number = 10,
  ): Promise<{ data: IDlqEntry[]; total: number }> {
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      DlqEntry.find().sort({ createdAt: -1 }).skip(skip).limit(limit).exec(),
      DlqEntry.countDocuments().exec(),
    ]);

    return { data, total };
  }

  /**
   * Retry a specific DLQ entry.
   */
  public async retryEntry(id: string): Promise<any> {
    const entry = await DlqEntry.findById(id);
    if (!entry) {
      throw new AppError('DLQ entry not found', StatusCodes.NOT_FOUND);
    }

    if (entry.status === DlqStatus.RESOLVED) {
      throw new AppError('DLQ entry is already resolved', StatusCodes.BAD_REQUEST);
    }

    // Increment retry count
    entry.retryCount += 1;
    entry.status = DlqStatus.RETRIED;
    await entry.save();

    try {
      // Dynamic import to break circular dependency with stellarService
      const { stellarService } = await import('./stellarService');

      // Currently, we assume the payload is a SubmitEscrowLockInput
      // since that's the main transaction failure we are catching.
      // If there are other types, we might need a type field in the DLQ entry.
      // For now, we attempt to retry it via stellarService.submitEscrowLock
      const result = await stellarService.submitEscrowLock(entry.payload);

      entry.status = DlqStatus.RESOLVED;
      await entry.save();
      return result;
    } catch (error: any) {
      // If it fails again, we log the new error but keep the status as RETRIED (or revert to PENDING)
      entry.errorReason = error.message || String(error);
      entry.status = DlqStatus.PENDING; // mark it pending again so it can be retried later
      await entry.save();
      throw new AppError(`Retry failed: ${entry.errorReason}`, StatusCodes.INTERNAL_SERVER_ERROR);
    }
  }
}

export const dlqService = new DlqService();
