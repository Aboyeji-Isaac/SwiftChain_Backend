import { Types } from 'mongoose';
import { assertSameAsset, validateAsset } from './currencyService';
import httpStatus from 'http-status-codes';
import Escrow, { IEscrow, EscrowStatus } from '../models/Escrow';
import Delivery, { DeliveryStatus } from '../models/Delivery';
import { AppError } from '../utils/AppError';
import logger from '../config/logger';
import { withLock } from '../config/redis';
import { proofOfDeliveryService } from './proofOfDeliveryService';
import { sorobanService } from '../blockchain/soroban.service';
import env from '../config/env';
import { nowUTC } from '../utils/dateUtils';

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

/** Input for listing escrows flagged as expired for admin review. */
export interface GetFlaggedEscrowsInput {
  page?: number;
  limit?: number;
}

/** Paginated result for listing escrows flagged as expired. */
export interface GetFlaggedEscrowsResult {
  escrows: IEscrow[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/** Input for an admin resolving a flagged (expired) escrow. */
export interface ResolveEscrowInput {
  escrowId: string;
  adminId: string;
  notes: string;
}

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

    const delivery = await Delivery.findById(input.deliveryId);
    if (!delivery) {
      throw new AppError('Delivery not found for escrow_funded event', httpStatus.NOT_FOUND);
    }

    const asset = validateAsset({ code: input.asset, issuer: input.assetIssuer });
    assertSameAsset(delivery.escrowAsset ?? { code: 'XLM' }, asset);
    if (!Number.isFinite(input.amount) || input.amount <= 0) {
      throw new AppError('Escrow amount must be positive and finite', httpStatus.BAD_REQUEST);
    }
    if (delivery.escrowAmount !== undefined && delivery.escrowAmount !== input.amount) {
      throw new AppError('Escrow amount must match the delivery', httpStatus.CONFLICT);
    }

    let escrow = await Escrow.findOne({ contractId: input.contractId });

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
      escrow.transactions.push(transaction);
      await escrow.save();
    } else {
      const lockedAt = new Date();
      escrow = await Escrow.create({
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
      delivery.status = DeliveryStatus.FUNDED;
      await delivery.save();
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
      status: EscrowStatus.LOCKED,
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
      { _id: { $in: idsToFlag }, status: EscrowStatus.LOCKED },
      {
        $set: {
          status: EscrowStatus.EXPIRED,
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

    return {
      scannedAt: now.toISOString(),
      flaggedCount: flaggedEscrows.length,
      flaggedEscrows,
    };
  }

  /**
   * Retrieve a paginated list of expired escrows flagged for admin review,
   * newest flags first.
   */
  async getFlaggedEscrows(input: GetFlaggedEscrowsInput): Promise<GetFlaggedEscrowsResult> {
    const page = Math.max(1, input.page ?? 1);
    const limit = Math.min(FLAGGED_ESCROWS_MAX_LIMIT, Math.max(1, input.limit ?? 20));
    const skip = (page - 1) * limit;

    const filter = { status: EscrowStatus.EXPIRED };

    const [escrows, total] = await Promise.all([
      Escrow.find(filter).sort({ flaggedAt: -1 }).skip(skip).limit(limit),
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

  /**
   * Marks a flagged (expired) escrow as resolved by an administrator.
   *
   * Only escrows currently in the `expired` state can be resolved — resolving
   * an active, released, refunded or already-resolved escrow is a conflict.
   * The admin id and notes are recorded on the escrow as an audit trail.
   */
  async resolveEscrow(input: ResolveEscrowInput): Promise<IEscrow> {
    const { escrowId, adminId, notes } = input;

    if (!Types.ObjectId.isValid(escrowId)) {
      throw new AppError('Invalid escrow ID format.', httpStatus.BAD_REQUEST);
    }

    const escrow = await Escrow.findById(escrowId);
    if (!escrow) {
      throw new AppError('Escrow not found.', httpStatus.NOT_FOUND);
    }

    if (escrow.status !== EscrowStatus.EXPIRED) {
      throw new AppError('Only escrows flagged as expired can be resolved.', httpStatus.CONFLICT);
    }

    escrow.status = EscrowStatus.RESOLVED;
    escrow.resolvedAt = new Date();
    escrow.resolvedBy = adminId;
    escrow.resolutionNotes = notes;

    await escrow.save();

    logger.info(
      `[EscrowMonitor] Admin ${adminId} resolved expired escrow ${escrowId}. Notes: "${notes}"`,
    );

    return escrow;
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
