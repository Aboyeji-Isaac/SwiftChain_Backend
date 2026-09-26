/**
 * EscrowIndexerService
 *
 * Service layer for escrow resolution (release/refund) indexing.
 * Handles database updates for escrow_released and escrow_refunded events.
 *
 * All DB operations live here — handlers stay thin.
 * All operations are idempotent: safe to call multiple times for the same event.
 */

import { Types } from 'mongoose';
import Escrow, { IEscrow, EscrowStatus } from '../models/Escrow';
import { EscrowResolvedEvent, TERMINAL_STATUSES } from '../indexer/types/escrowEvents';
import logger from '../config/logger';

export interface EscrowReleaseInput {
  escrowId: string;
  transactionHash: string;
  ledger: number;
  timestamp: number;
}

export interface EscrowRefundInput {
  escrowId: string;
  transactionHash: string;
  ledger: number;
  timestamp: number;
}

export class EscrowIndexerService {
  /**
   * Handles an escrow_released event from the Soroban indexer.
   * Updates escrow status to 'released' and records the settlement transaction.
   *
   * Idempotent: replaying the same transaction hash is a no-op so the indexer
   * can safely re-process a ledger range without producing duplicate updates.
   *
   * @param event - The typed escrow_released event
   * @throws Error if database operation fails (not caught; caller handles)
   */
  async handleEscrowReleased(event: EscrowResolvedEvent): Promise<void> {
    const { escrowId, transactionHash, ledger, timestamp } = event;

    // Check for idempotency: if this transaction hash is already recorded, skip
    const existing = await Escrow.findOne({
      $or: [
        { _id: Types.ObjectId.isValid(escrowId) ? escrowId : undefined },
        { contractId: escrowId },
      ].filter((q) => q !== undefined),
      'transactions.hash': transactionHash,
    });

    if (existing) {
      logger.info(
        `[EscrowIndexerService] Skipping already-processed escrow_released txHash=${transactionHash}`,
      );
      return;
    }

    // Update only if not already in a terminal status (released or refunded)
    const updated = await Escrow.findOneAndUpdate(
      {
        $or: [
          { _id: Types.ObjectId.isValid(escrowId) ? new Types.ObjectId(escrowId) : undefined },
          { contractId: escrowId },
        ].filter((q) => q !== undefined),
        status: { $nin: Array.from(TERMINAL_STATUSES) },
      },
      {
        $set: {
          status: EscrowStatus.RELEASED,
          releaseTransactionHash: transactionHash,
          releasedAt: new Date(timestamp * 1000),
          lastSyncedLedger: ledger,
        },
        $push: {
          transactions: {
            hash: transactionHash,
            type: 'release',
            ledger,
            recordedAt: new Date(),
          },
        },
      },
      { new: true },
    );

    if (!updated) {
      logger.warn(
        `[EscrowIndexerService] escrow_released: no update for escrowId=${escrowId} — already resolved or not found`,
      );
      return;
    }

    logger.info(
      `[EscrowIndexerService] Escrow released: escrowId=${escrowId} txHash=${transactionHash} ledger=${ledger}`,
    );
  }

  /**
   * Handles an escrow_refunded event from the Soroban indexer.
   * Updates escrow status to 'refunded' and records the settlement transaction.
   *
   * Idempotent: replaying the same transaction hash is a no-op so the indexer
   * can safely re-process a ledger range without producing duplicate updates.
   *
   * @param event - The typed escrow_refunded event
   * @throws Error if database operation fails (not caught; caller handles)
   */
  async handleEscrowRefunded(event: EscrowResolvedEvent): Promise<void> {
    const { escrowId, transactionHash, ledger, timestamp } = event;

    // Check for idempotency: if this transaction hash is already recorded, skip
    const existing = await Escrow.findOne({
      $or: [
        { _id: Types.ObjectId.isValid(escrowId) ? escrowId : undefined },
        { contractId: escrowId },
      ].filter((q) => q !== undefined),
      'transactions.hash': transactionHash,
    });

    if (existing) {
      logger.info(
        `[EscrowIndexerService] Skipping already-processed escrow_refunded txHash=${transactionHash}`,
      );
      return;
    }

    // Update only if not already in a terminal status (released or refunded)
    const updated = await Escrow.findOneAndUpdate(
      {
        $or: [
          { _id: Types.ObjectId.isValid(escrowId) ? new Types.ObjectId(escrowId) : undefined },
          { contractId: escrowId },
        ].filter((q) => q !== undefined),
        status: { $nin: Array.from(TERMINAL_STATUSES) },
      },
      {
        $set: {
          status: EscrowStatus.REFUNDED,
          refundTransactionHash: transactionHash,
          refundedAt: new Date(timestamp * 1000),
          lastSyncedLedger: ledger,
        },
        $push: {
          transactions: {
            hash: transactionHash,
            type: 'refund',
            ledger,
            recordedAt: new Date(),
          },
        },
      },
      { new: true },
    );

    if (!updated) {
      logger.warn(
        `[EscrowIndexerService] escrow_refunded: no update for escrowId=${escrowId} — already resolved or not found`,
      );
      return;
    }

    logger.info(
      `[EscrowIndexerService] Escrow refunded: escrowId=${escrowId} txHash=${transactionHash} ledger=${ledger}`,
    );
  }

  /**
   * Retrieves an escrow by its MongoDB ObjectId or contract ID.
   * Used by controllers for querying escrow status.
   *
   * @param escrowId - MongoDB ObjectId or contract ID
   * @returns The escrow document, or null if not found
   */
  async getEscrowByEscrowId(escrowId: string): Promise<IEscrow | null> {
    const query: Record<string, unknown> = {};

    if (Types.ObjectId.isValid(escrowId)) {
      query._id = new Types.ObjectId(escrowId);
    } else {
      query.contractId = escrowId;
    }

    return Escrow.findOne(query).lean().exec();
  }
}

export const escrowIndexerService = new EscrowIndexerService();
