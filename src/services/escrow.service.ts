import { FilterQuery, SortOrder, Types } from 'mongoose';
import AuditLog from '../models/AuditLog';
import { notificationService } from './notificationService';
import { webhookService } from './webhookService';
import { assertSameAsset, validateAsset } from './currencyService';
import { escrowRepository } from '../repositories/EscrowRepository';
import { deliveryRepository } from '../repositories/DeliveryRepository';
import httpStatus from 'http-status-codes';
import Escrow, { IEscrow, EscrowStatus } from '../models/Escrow';
import Delivery, { DeliveryStatus, IDelivery } from '../models/Delivery';
import AuditLog from '../models/AuditLog';
import { AppError } from '../utils/AppError';
import logger from '../config/logger';
import { withLock } from '../config/redis';
import { proofOfDeliveryService } from './proofOfDeliveryService';
import { sorobanService } from '../blockchain/soroban.service';
import env from '../config/env';
import { nowUTC } from '../utils/dateUtils';
import { deliveryService } from './delivery.service';
import { DeliveryMilestone, MILESTONE_BY_STATUS } from '../models/DeliveryEvent';

/**
 * Reason stamped on a delivery (and its audit-log entry) when it is
 * auto-cancelled because its escrow funding window lapsed (issue #247).
 */
export const FUNDING_WINDOW_LAPSED_REASON =
  'Escrow funding window lapsed: the escrow was not funded before the fundBy deadline.';

/** Data extracted from an on-chain `escrow_funded` contract event. */
export interface EscrowFundedInput {
  contractId: string;
  deliveryId: string;
  amount: number;
  /** Asset code of the escrowed funds as reported by the contract (e.g. `XLM`). */
  asset: string;
  assetIssuer?: string;
  /** Stellar account that funded the escrow, when present in the event. */
  fundedBy?: string;
  transactionHash: string;
  ledger?: number;
}

/** Input data for releasing an escrow. */
export interface ReleaseEscrowInput {
  /** MongoDB ObjectId or contractId of the escrow to release. */
  escrowId: string;
  /** Transaction hash of the on-chain release operation. */
  transactionHash: string;
  /** Optional ledger sequence for audit trail. */
  ledger?: number;
  /** User or system identifier initiating the release. */
  releasedBy?: string;
}

/** Result of one pass of the expired-escrow scan. */
export interface ScanExpiredEscrowsResult {
  scannedAt: string;
  flaggedCount: number;
  flaggedEscrows: IEscrow[];
}

/** Categories of escrows surfaced to admins for review. */
export type FlaggedEscrowFilter = 'disputed' | 'expired' | 'suspicious';

export const FLAGGED_ESCROW_FILTERS: readonly FlaggedEscrowFilter[] = [
  'disputed',
  'expired',
  'suspicious',
];

/** Input for listing escrows flagged for admin review. */
export interface GetFlaggedEscrowsInput {
  page?: number;
  limit?: number;
  /** Restrict to one category; all categories when omitted. */
  type?: FlaggedEscrowFilter;
  sort?: Record<string, SortOrder>;
}

/** Paginated result for listing flagged escrows. */
export interface GetFlaggedEscrowsResult {
  escrows: IEscrow[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/** Outcomes an admin may choose when resolving a flagged escrow. */
export enum EscrowResolution {
  RELEASE_TO_DRIVER = 'release_to_driver',
  REFUND_TO_PAYER = 'refund_to_payer',
  KEEP_LOCKED = 'keep_locked',
}

/** Input for an admin resolving a flagged escrow. */
export interface ResolveEscrowInput {
  escrowId: string;
  adminId: string;
  resolution: EscrowResolution;
  reason: string;
}

/** Admin actions available for an expired escrow. */
export enum ExpiredEscrowAction {
  /** Re-lock the funds with a fresh expiry and restore the delivery. */
  REFUND = 'refund',
  /** Close out the escrow and cancel the delivery for good. */
  CANCEL = 'cancel',
}

export interface RetryExpiredEscrowInput {
  escrowId: string;
  adminId: string;
  action: ExpiredEscrowAction;
  reason: string;
}

/** Statuses that can be resolved by an admin. */
const RESOLVABLE_STATUSES: ReadonlySet<EscrowStatus> = new Set([
  EscrowStatus.LOCKED,
  EscrowStatus.DISPUTED,
  EscrowStatus.EXPIRED,
]);

/** Statuses the expiry scan transitions to `expired`. */
const EXPIRABLE_STATUSES: readonly EscrowStatus[] = [EscrowStatus.PENDING, EscrowStatus.LOCKED];

/** Largest page size accepted when listing flagged escrows. */
const FLAGGED_ESCROWS_MAX_LIMIT = 100;

export class EscrowService {
  /**
   * Record an `escrow_funded` event: create or update the Escrow document
   * for the contract and mark the related Delivery as funded.
   *
   * Idempotent — replaying the same transaction hash for an already
   * recorded escrow is a no-op so the indexer can safely re-process a
   * ledger range without producing duplicate side effects.
   */
  async recordEscrowFunded(input: EscrowFundedInput): Promise<IEscrow> {
    if (!Types.ObjectId.isValid(input.deliveryId)) {
      throw new AppError('Invalid deliveryId', httpStatus.BAD_REQUEST);
    }

    const delivery = await deliveryRepository.findById(input.deliveryId);
    if (!delivery) {
      throw new AppError('Delivery not found for escrow_funded event', httpStatus.NOT_FOUND);
    }

    // ── Escrow funding window (issue #247) ────────────────────────────
    // Policy: a cancelled delivery stays cancelled — a late funding event is
    // rejected with a clear error rather than resurrecting it. A delivery whose
    // window has just lapsed is cancelled here (same outcome as the cron scan)
    // before its funding attempt is rejected, so the limbo state never survives
    // a fund request even if the monitor tick has not run yet.
    if (delivery.status === DeliveryStatus.CANCELLED) {
      throw new AppError(this.fundingRejectedMessage(delivery), httpStatus.CONFLICT);
    }
    if (this.isFundingWindowLapsed(delivery)) {
      await this.cancelLapsedFundingWindow(delivery, FUNDING_WINDOW_LAPSED_REASON);
      throw new AppError(this.fundingRejectedMessage(delivery), httpStatus.CONFLICT);
    }

    const asset = validateAsset({ code: input.asset, issuer: input.assetIssuer });
    assertSameAsset(delivery.escrowAsset ?? { code: 'XLM' }, asset);
    if (!Number.isFinite(input.amount) || input.amount <= 0) {
      throw new AppError('Escrow amount must be positive and finite', httpStatus.BAD_REQUEST);
    }
    if (delivery.escrowAmount !== undefined && delivery.escrowAmount !== input.amount) {
      throw new AppError('Escrow amount must match the delivery', httpStatus.CONFLICT);
    }

    let escrow = await escrowRepository.findByContractId(input.contractId);
    const deliveryEscrow = await escrowRepository.findByDeliveryId(delivery._id);
    if (deliveryEscrow && deliveryEscrow.contractId !== input.contractId) {
      throw new AppError('Delivery already has a different escrow contract', httpStatus.CONFLICT);
    }

    if (escrow && String(escrow.delivery) !== String(delivery._id)) {
      throw new AppError('Contract is already linked to another delivery', httpStatus.CONFLICT);
    }
    if (
      escrow &&
      escrow.assetCode &&
      (escrow.assetCode !== asset.code || escrow.assetIssuer !== asset.issuer)
    ) {
      throw new AppError('Escrow asset cannot change', httpStatus.CONFLICT);
    }

    if (escrow?.transactions.some((tx) => tx.hash === input.transactionHash)) {
      logger.info(
        `[EscrowService] Skipping already-processed escrow_funded tx=${input.transactionHash}`,
      );
      return escrow;
    }
    if (escrow && escrow.status !== EscrowStatus.LOCKED && escrow.status !== EscrowStatus.PENDING) {
      throw new AppError('Settled escrow cannot be funded again', httpStatus.CONFLICT);
    }

    const transaction = {
      hash: input.transactionHash,
      type: 'fund' as const,
      ledger: input.ledger,
      recordedAt: new Date(),
    };

    if (escrow) {
      escrow.amount = input.amount;
      escrow.assetCode = asset.code;
      escrow.assetIssuer = asset.issuer;
      escrow.payerAddress = input.fundedBy;
      escrow.status = EscrowStatus.LOCKED;
      escrow.lockedAt = escrow.lockedAt ?? new Date();
      escrow.expiresAt = this.computeExpiresAt(escrow.lockedAt);
      const updated = await escrowRepository.updateById(String(escrow._id), {
        $set: {
          amount: escrow.amount,
          assetCode: escrow.assetCode,
          assetIssuer: escrow.assetIssuer,
          payerAddress: escrow.payerAddress,
          status: escrow.status,
          lockedAt: escrow.lockedAt,
          expiresAt: escrow.expiresAt,
        },
        $push: { transactions: transaction },
      });
      if (!updated) throw new AppError('Escrow changed while funding', httpStatus.CONFLICT);
      escrow = updated;
    } else {
      const lockedAt = new Date();
      escrow = await escrowRepository.create({
        delivery: delivery._id,
        contractId: input.contractId,
        amount: input.amount,
        assetCode: asset.code,
        assetIssuer: asset.issuer,
        payerAddress: input.fundedBy,
        status: EscrowStatus.LOCKED,
        lockedAt,
        expiresAt: this.computeExpiresAt(lockedAt),
        transactions: [transaction],
      });
    }

    if (delivery.status !== DeliveryStatus.FUNDED) {
      const previousStatus = delivery.status;
      delivery.status = DeliveryStatus.FUNDED;
      await deliveryRepository.updateById(String(delivery._id), {
        $set: { status: DeliveryStatus.FUNDED },
      });

      // Fire-after-commit: the status write above has landed.
      await deliveryService.emitMilestone(
        delivery,
        {
          name: MILESTONE_BY_STATUS[DeliveryStatus.FUNDED],
          fromStatus: previousStatus,
          payload: { contractId: input.contractId, transactionHash: input.transactionHash },
        },
        { type: 'system' },
      );
    }

    logger.info(
      `[EscrowService] escrow_funded recorded — contract=${input.contractId} ` +
        `delivery=${input.deliveryId} tx=${input.transactionHash}`,
    );

    return escrow;
  }

  async getByDeliveryId(deliveryId: string): Promise<IEscrow> {
    if (!Types.ObjectId.isValid(deliveryId)) {
      throw new AppError('Invalid deliveryId', httpStatus.BAD_REQUEST);
    }

    const escrow = await Escrow.findOne({ delivery: deliveryId });
    if (!escrow) {
      throw new AppError('Escrow not found for delivery', httpStatus.NOT_FOUND);
    }

    return escrow;
  }

  async getByContractId(contractId: string): Promise<IEscrow> {
    const escrow = await Escrow.findOne({ contractId });
    if (!escrow) {
      throw new AppError('Escrow not found for contract', httpStatus.NOT_FOUND);
    }

    return escrow;
  }

  /**
   * Release an escrow using distributed locking to prevent race conditions.
   *
   * This method acquires a Redis lock before processing the release to ensure
   * that concurrent requests cannot release the same escrow twice. The lock is
   * held for the duration of the transaction and automatically released afterward.
   *
   * @param input - Release escrow input data
   * @returns The updated escrow document
   * @throws AppError if the escrow is not found, not in LOCKED status, or lock acquisition fails
   *
   * @example
   * const escrow = await escrowService.releaseEscrow({
   *   escrowId: '507f1f77bcf86cd799439011',
   *   transactionHash: '0xabc123...',
   *   ledger: 12345,
   *   releasedBy: 'user_id_or_system'
   * });
   */
  async releaseEscrow(input: ReleaseEscrowInput): Promise<IEscrow> {
    const { escrowId, transactionHash, ledger, releasedBy } = input;

    // Validate escrowId format
    if (!Types.ObjectId.isValid(escrowId) && !escrowId.startsWith('C')) {
      throw new AppError('Invalid escrowId format', httpStatus.BAD_REQUEST);
    }

    // Define the lock resource key
    const lockResource = `escrow:release:${escrowId}`;

    logger.info(
      `[EscrowService] Attempting to release escrow — id=${escrowId} tx=${transactionHash}`,
    );

    // Execute release within a distributed lock
    return await withLock(lockResource, async () => {
      logger.debug(`[EscrowService] Lock acquired for escrow release — id=${escrowId}`);

      // Fetch the escrow (by ObjectId or contractId)
      let escrow: IEscrow | null = null;

      if (Types.ObjectId.isValid(escrowId)) {
        escrow = await Escrow.findById(escrowId);
      } else {
        escrow = await Escrow.findOne({ contractId: escrowId });
      }

      if (!escrow) {
        throw new AppError('Escrow not found', httpStatus.NOT_FOUND);
      }

      // Check if this transaction has already been recorded (idempotency).
      // This runs before the status guards so replaying a release event that
      // already settled the escrow stays a no-op instead of a conflict.
      if (escrow.transactions.some((tx) => tx.hash === transactionHash)) {
        logger.info(
          `[EscrowService] Skipping already-processed release tx=${transactionHash} for escrow=${escrowId}`,
        );
        return escrow;
      }

      // Check if the escrow is already released
      if (escrow.status === EscrowStatus.RELEASED) {
        logger.warn(
          `[EscrowService] Escrow already released — id=${escrowId} status=${escrow.status}`,
        );
        throw new AppError('Escrow has already been released', httpStatus.CONFLICT);
      }

      // Check if the escrow is in a valid state to be released
      if (escrow.status !== EscrowStatus.LOCKED) {
        throw new AppError(
          `Escrow cannot be released from status: ${escrow.status}`,
          httpStatus.CONFLICT,
        );
      }

      // Proof of delivery must be on record before funds can be released —
      // this is the enforcement point regardless of which path (API call,
      // indexer event) triggers a release.
      await proofOfDeliveryService.assertProofOfDeliveryExists(String(escrow.delivery));

      // Record the release transaction
      const releaseTransaction = {
        hash: transactionHash,
        type: 'release' as const,
        ledger,
        recordedAt: new Date(),
      };

      escrow.status = EscrowStatus.RELEASED;
      escrow.releasedAt = new Date();
      escrow.transactions.push(releaseTransaction);

      await escrow.save();

      // Update related delivery status to COMPLETED
      const delivery = await Delivery.findById(escrow.delivery);
      if (delivery && delivery.status !== DeliveryStatus.COMPLETED) {
        delivery.status = DeliveryStatus.COMPLETED;
        await delivery.save();
        logger.debug(
          `[EscrowService] Delivery status updated to COMPLETED — delivery=${String(
            escrow.delivery,
          )}`,
        );
      }

      logger.info(
        `[EscrowService] Escrow released successfully — id=${escrowId} ` +
          `contract=${escrow.contractId} tx=${transactionHash} releasedBy=${
            releasedBy ?? 'system'
          }`,
      );

      return escrow;
    });
  }

  /**
   * Scan for escrows whose lock TTL has elapsed and flag them as `expired`.
   *
   * Called on a recurring schedule by the escrow monitor cron job. Runs a
   * single `updateMany` for efficiency, then reloads the flagged documents for
   * logging/reporting purposes.
   *
   * The current Soroban ledger sequence is stamped onto each flagged escrow so
   * there is an on-chain-anchored audit trail of when the expiry was detected.
   * A degraded/unavailable RPC node only downgrades the audit stamp to
   * "unknown" — the scan itself still flags the escrows.
   */
  async scanForExpiredEscrows(): Promise<ScanExpiredEscrowsResult> {
    const now = nowUTC();

    const expiredCandidates = await Escrow.find({
      status: { $in: EXPIRABLE_STATUSES },
      expiresAt: { $lte: now },
    });

    if (expiredCandidates.length === 0) {
      return { scannedAt: now.toISOString(), flaggedCount: 0, flaggedEscrows: [] };
    }

    let flaggedLedger: number | undefined;
    try {
      const latestLedger = await sorobanService.getLatestLedger();
      // getLatestLedger resolves to a DegradedLedgerResult when the circuit
      // breaker is open — treat that as "ledger unknown" rather than a number.
      flaggedLedger = typeof latestLedger === 'number' ? latestLedger : undefined;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      logger.warn(
        `[EscrowMonitor] Failed to fetch latest Soroban ledger for audit stamp: ${message}`,
      );
    }

    const idsToFlag = expiredCandidates.map((escrow) => escrow._id);

    await Escrow.updateMany(
      { _id: { $in: idsToFlag }, status: { $in: EXPIRABLE_STATUSES } },
      {
        $set: {
          status: EscrowStatus.EXPIRED,
          expiredAt: now,
          flaggedAt: now,
          ...(flaggedLedger !== undefined ? { flaggedLedger } : {}),
        },
      },
    );

    const flaggedEscrows = await Escrow.find({
      _id: { $in: idsToFlag },
      status: EscrowStatus.EXPIRED,
    });

    logger.info(
      `[EscrowMonitor] Flagged ${flaggedEscrows.length} expired escrow(s) at ledger=${
        flaggedLedger ?? 'unknown'
      }`,
    );

    for (const escrow of flaggedEscrows) {
      await this.cancelDeliveryForExpiredEscrow(escrow);
    }

    return {
      scannedAt: now.toISOString(),
      flaggedCount: flaggedEscrows.length,
      flaggedEscrows,
    };
  }

  /**
   * Cancel the delivery behind an expired escrow and notify its stakeholders
   * through the notification and webhook paths. Failures are logged so one
   * bad delivery never aborts the rest of the scan.
   */
  private async cancelDeliveryForExpiredEscrow(escrow: IEscrow): Promise<void> {
    try {
      const delivery = await Delivery.findById(escrow.delivery);
      if (!delivery || delivery.status === DeliveryStatus.COMPLETED) return;
      if (delivery.status !== DeliveryStatus.CANCELLED) {
        delivery.status = DeliveryStatus.CANCELLED;
        await delivery.save();
      }

      await Promise.allSettled([
        notificationService.notifyDeliveryTransition(delivery, DeliveryStatus.CANCELLED),
        webhookService.dispatchDeliveryEvent(delivery, DeliveryStatus.CANCELLED),
      ]);

      logger.info(
        `[EscrowMonitor] Delivery ${String(delivery._id)} cancelled for expired escrow ${String(
          escrow._id,
        )}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      logger.error(
        `[EscrowMonitor] Failed to cancel delivery for expired escrow ${String(
          escrow._id,
        )}: ${message}`,
      );
    }
  }

  /**
   * Retrieve a paginated list of escrows needing admin review: disputed,
   * expired, or suspicious (locked past expiry without being scanned yet, or
   * locked without a recorded payer).
   */
  async getFlaggedEscrows(input: GetFlaggedEscrowsInput): Promise<GetFlaggedEscrowsResult> {
    const page = Math.max(1, input.page ?? 1);
    const limit = Math.min(FLAGGED_ESCROWS_MAX_LIMIT, Math.max(1, input.limit ?? 20));
    const skip = (page - 1) * limit;

    const filter = this.buildFlaggedFilter(input.type);
    const sort = input.sort && Object.keys(input.sort).length > 0 ? input.sort : { updatedAt: -1 };

    const [escrows, total] = await Promise.all([
      Escrow.find(filter).sort(sort).skip(skip).limit(limit),
      Escrow.countDocuments(filter),
    ]);

    return {
      escrows,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 0,
    };
  }

  private buildFlaggedFilter(type?: FlaggedEscrowFilter): FilterQuery<IEscrow> {
    const disputed: FilterQuery<IEscrow> = { status: EscrowStatus.DISPUTED };
    const expired: FilterQuery<IEscrow> = { status: EscrowStatus.EXPIRED };
    const suspicious: FilterQuery<IEscrow> = {
      status: EscrowStatus.LOCKED,
      $or: [{ expiresAt: { $lte: nowUTC() } }, { payerAddress: { $in: [null, ''] } }],
    };

    switch (type) {
      case 'disputed':
        return disputed;
      case 'expired':
        return expired;
      case 'suspicious':
        return suspicious;
      default:
        return { $or: [disputed, expired, suspicious] };
    }
  }

  /**
   * Resolve a flagged escrow under a distributed lock: release funds to the
   * driver, refund the payer, or keep the funds locked with a fresh expiry.
   * Terminal escrows cannot be resolved. Every resolution is audit-logged.
   */
  async resolveEscrow(input: ResolveEscrowInput): Promise<IEscrow> {
    const { escrowId, adminId, resolution, reason } = input;

    if (!Types.ObjectId.isValid(escrowId)) {
      throw new AppError('Invalid escrow ID format.', httpStatus.BAD_REQUEST);
    }
    if (!Object.values(EscrowResolution).includes(resolution)) {
      throw new AppError('Invalid resolution.', httpStatus.BAD_REQUEST);
    }

    return withLock(`escrow:resolve:${escrowId}`, async () => {
      const escrow = await Escrow.findById(escrowId);
      if (!escrow) {
        throw new AppError('Escrow not found.', httpStatus.NOT_FOUND);
      }
      if (!RESOLVABLE_STATUSES.has(escrow.status)) {
        throw new AppError(
          `Escrow cannot be resolved from status: ${escrow.status}`,
          httpStatus.CONFLICT,
        );
      }

      const previousStatus = escrow.status;
      const now = new Date();
      let deliveryStatus: DeliveryStatus | undefined;

      switch (resolution) {
        case EscrowResolution.RELEASE_TO_DRIVER:
          escrow.status = EscrowStatus.RELEASED;
          escrow.releasedAt = now;
          deliveryStatus = DeliveryStatus.COMPLETED;
          break;
        case EscrowResolution.REFUND_TO_PAYER:
          escrow.status = EscrowStatus.REFUNDED;
          escrow.refundedAt = now;
          deliveryStatus = DeliveryStatus.CANCELLED;
          break;
        case EscrowResolution.KEEP_LOCKED:
          escrow.status = EscrowStatus.LOCKED;
          escrow.expiresAt = this.computeExpiresAt(now);
          break;
      }

      escrow.resolvedAt = now;
      escrow.resolvedBy = adminId;
      escrow.resolutionNotes = reason;
      await escrow.save();

      if (deliveryStatus) {
        await this.applyDeliveryStatus(escrow, deliveryStatus);
      }

      await this.writeAuditLog('escrow.resolve', adminId, escrow, reason, {
        resolution,
        previousStatus,
        newStatus: escrow.status,
      });

      logger.info(
        `[EscrowService] Admin ${adminId} resolved escrow ${escrowId} ` +
          `(${previousStatus} -> ${escrow.status}) resolution=${resolution}`,
      );

      return escrow;
    });
  }

  /**
   * Admin retry path for an expired escrow: re-fund it (re-lock with a fresh
   * expiry and restore the delivery to FUNDED) or fully cancel it.
   */
  async retryExpiredEscrow(input: RetryExpiredEscrowInput): Promise<IEscrow> {
    const { escrowId, adminId, action, reason } = input;

    if (!Types.ObjectId.isValid(escrowId)) {
      throw new AppError('Invalid escrow ID format.', httpStatus.BAD_REQUEST);
    }
    if (!Object.values(ExpiredEscrowAction).includes(action)) {
      throw new AppError('Invalid action.', httpStatus.BAD_REQUEST);
    }

    return withLock(`escrow:resolve:${escrowId}`, async () => {
      const escrow = await Escrow.findById(escrowId);
      if (!escrow) {
        throw new AppError('Escrow not found.', httpStatus.NOT_FOUND);
      }
      if (escrow.status !== EscrowStatus.EXPIRED) {
        throw new AppError('Only expired escrows can be retried.', httpStatus.CONFLICT);
      }

      const now = new Date();
      if (action === ExpiredEscrowAction.REFUND) {
        escrow.status = EscrowStatus.LOCKED;
        escrow.lockedAt = now;
        escrow.expiresAt = this.computeExpiresAt(now);
        escrow.expiredAt = undefined;
        escrow.flaggedAt = undefined;
      } else {
        escrow.status = EscrowStatus.RESOLVED;
      }
      escrow.resolvedAt = now;
      escrow.resolvedBy = adminId;
      escrow.resolutionNotes = reason;
      await escrow.save();

      await this.applyDeliveryStatus(
        escrow,
        action === ExpiredEscrowAction.REFUND ? DeliveryStatus.FUNDED : DeliveryStatus.CANCELLED,
      );

      await this.writeAuditLog('escrow.expired_retry', adminId, escrow, reason, {
        action,
        newStatus: escrow.status,
      });

      return escrow;
    });
  }

  /** Move the escrow's delivery to `status` and notify stakeholders. */
  private async applyDeliveryStatus(escrow: IEscrow, status: DeliveryStatus): Promise<void> {
    const delivery = await Delivery.findById(escrow.delivery);
    if (!delivery || delivery.status === status) return;

    delivery.status = status;
    await delivery.save();

    await Promise.allSettled([
      notificationService.notifyDeliveryTransition(delivery, status),
      webhookService.dispatchDeliveryEvent(delivery, status),
    ]);
  }

  private async writeAuditLog(
    action: string,
    adminId: string,
    escrow: IEscrow,
    reason: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    try {
      await AuditLog.create({
        action,
        actor: Types.ObjectId.isValid(adminId) ? new Types.ObjectId(adminId) : null,
        targetType: 'Escrow',
        targetId: escrow._id,
        description: reason,
        meta: { ...meta, deliveryId: String(escrow.delivery) },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      logger.error(
        `[EscrowService] Failed to write audit log for escrow ${String(escrow._id)}: ${message}`,
      );
    }
  }

  /**
   * True when a delivery still carries an escrow amount whose `fundBy`
   * deadline has passed while the delivery is unfunded (`pending`).
   */
  private isFundingWindowLapsed(delivery: IDelivery): boolean {
    return (
      delivery.status === DeliveryStatus.PENDING &&
      delivery.fundBy instanceof Date &&
      delivery.fundBy.getTime() <= Date.now()
    );
  }

  /**
   * The rejection a customer sees when they try to fund a delivery whose
   * funding window has lapsed (i.e. a cancelled delivery).
   */
  private fundingRejectedMessage(delivery: IDelivery): string {
    const reason = delivery.cancellationReason ?? FUNDING_WINDOW_LAPSED_REASON;
    const deadline = delivery.fundBy
      ? ` The funding window closed at ${delivery.fundBy.toISOString()}.`
      : '';
    return `Delivery ${String(
      delivery._id,
    )} is cancelled and can no longer be funded: ${reason}${deadline} Create a new delivery to fund it.`;
  }

  /**
   * Cancel a delivery whose escrow funding window lapsed (issue #247).
   *
   * The transition is applied with a conditional update that asserts the
   * current status, so a concurrent fund/cancel can never double-cancel the
   * same delivery — the loser matches no document and is left untouched.
   *
   * On success the delivery is moved to `CANCELLED` with `cancellationReason`,
   * an audit-log entry is written, and the `funding_window_lapsed` milestone is
   * raised — the milestone fan-out notifies the customer (via the `cancelled`
   * status event) and reaches webhooks and sockets.
   *
   * Never throws: a failed audit write or milestone fan-out is logged and
   * isolated so the cancellation itself always stands (mirrors the
   * fire-after-commit behaviour of {@link deliveryService.emitMilestone}).
   *
   * @returns The cancelled delivery, or the input unchanged when it is no
   *          longer cancellable (already cancelled / no window / not pending).
   */
  async cancelLapsedFundingWindow(
    delivery: IDelivery,
    reason: string = FUNDING_WINDOW_LAPSED_REASON,
  ): Promise<IDelivery> {
    if (!this.isFundingWindowLapsed(delivery)) {
      return delivery;
    }

    const previousStatus = delivery.status;
    const fundBy = delivery.fundBy as Date;
    const updated = await deliveryRepository.updateOne(
      { _id: delivery._id, status: previousStatus },
      {
        $set: {
          status: DeliveryStatus.CANCELLED,
          cancellationReason: reason,
        },
      },
      { runValidators: true },
    );

    if (!updated) {
      // A concurrent transition (e.g. the funding event won the race) matched
      // no document — leave the delivery exactly as it now stands.
      logger.warn(
        `[EscrowService] Funding-window cancellation skipped — delivery=${String(
          delivery._id,
        )} changed concurrently.`,
      );
      return delivery;
    }

    await this.recordFundingWindowAudit(updated, reason, previousStatus, fundBy);

    // Fire-after-commit: the status write above has landed.
    await deliveryService.emitMilestone(
      updated,
      {
        name: DeliveryMilestone.FUNDING_WINDOW_LAPSED,
        fromStatus: previousStatus,
        payload: {
          reason,
          fundBy: fundBy.toISOString(),
          fundingWindowSeconds: env.ESCROW_FUNDING_WINDOW_SECONDS,
          escrowAmount: updated.escrowAmount ?? null,
        },
      },
      { type: 'system' },
    );

    logger.info(
      `[EscrowService] Funding window lapsed — delivery=${String(updated._id)} ` +
        `tracking=${updated.trackingNumber ?? 'n/a'} fundBy=${fundBy.toISOString()}`,
    );

    return updated;
  }

  /**
   * Scan for deliveries whose escrow funding window has lapsed and cancel
   * them. Called on the same recurring schedule as the escrow-expiry scan.
   *
   * Only unfunded (`pending`), non-archived deliveries with a `fundBy` in the
   * past are candidates; each cancellation is isolated so one failure cannot
   * stall the rest of the batch.
   */
  async scanLapsedFundingWindows(): Promise<ScanLapsedFundingWindowsResult> {
    const now = nowUTC();

    const lapsed = await Delivery.find({
      status: DeliveryStatus.PENDING,
      fundBy: { $lte: now },
      isDeleted: { $ne: true },
    }).sort({ fundBy: 1 });

    const cancelledDeliveryIds: string[] = [];

    for (const delivery of lapsed) {
      try {
        const cancelled = await this.cancelLapsedFundingWindow(delivery);
        if (cancelled.status === DeliveryStatus.CANCELLED) {
          cancelledDeliveryIds.push(String(cancelled._id));
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        logger.error(
          `[EscrowService] Failed to cancel delivery=${String(delivery._id)} ` +
            `after a funding-window lapse: ${message}`,
        );
      }
    }

    if (cancelledDeliveryIds.length > 0) {
      logger.info(
        `[EscrowService] Funding-window scan cancelled ${cancelledDeliveryIds.length} unfunded delivery(ies).`,
      );
    }

    return {
      scannedAt: now.toISOString(),
      cancelledCount: cancelledDeliveryIds.length,
      cancelledDeliveryIds,
    };
  }

  /**
   * Best-effort audit-log entry for a funding-window cancellation. Failures
   * are logged and swallowed — the cancellation has already committed and must
   * not be rolled back by an audit write.
   */
  private async recordFundingWindowAudit(
    delivery: IDelivery,
    reason: string,
    previousStatus: DeliveryStatus,
    fundBy: Date,
  ): Promise<void> {
    try {
      await AuditLog.create({
        action: 'funding_window_lapsed',
        targetType: 'delivery',
        targetId: delivery._id,
        description: reason,
        meta: {
          deliveryId: String(delivery._id),
          trackingNumber: delivery.trackingNumber ?? null,
          fromStatus: previousStatus,
          toStatus: DeliveryStatus.CANCELLED,
          fundBy: fundBy.toISOString(),
          escrowAmount: delivery.escrowAmount ?? null,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      logger.error(
        `[EscrowService] Failed to write funding-window audit entry for delivery=${String(
          delivery._id,
        )}: ${message}`,
      );
    }
  }

  /**
   * Derive the lock expiry timestamp from the lock time.
   *
   * Escrow locks are time-boxed (see the escrow TTL configuration); stamping
   * `expiresAt` at lock time lets the monitor's scan find stale locks with a
   * plain indexed `$lte` query instead of computing ages on the fly.
   */
  private computeExpiresAt(lockedAt: Date): Date {
    const ttlMs = env.ESCROW_LOCK_TTL_SECONDS * 1000;
    return new Date(lockedAt.getTime() + ttlMs);
  }
}

export const escrowService = new EscrowService();
export default escrowService;
