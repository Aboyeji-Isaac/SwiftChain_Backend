import { Types } from 'mongoose';
import Escrow, { EscrowStatus, IEscrow, IEscrowTransaction } from '../models/Escrow';
import { BaseRepository } from './BaseRepository';
import { ReadOptions, WriteOptions } from './types';

/**
 * Persistence gateway for the `Escrow` collection.
 *
 * Escrow records mirror on-chain Soroban contract state, so writes here are
 * expressed as explicit state transitions rather than free-form updates. The
 * transition helpers below make the expected prior state part of the query,
 * which prevents a replayed or duplicated chain event from, say, releasing an
 * escrow twice.
 */
export class EscrowRepository extends BaseRepository<IEscrow> {
  constructor() {
    super(Escrow);
  }

  /** The escrow guarding a given delivery, if one has been created. */
  async findByDeliveryId(
    deliveryId: string | Types.ObjectId,
    options?: ReadOptions<IEscrow>,
  ): Promise<IEscrow | null> {
    if (typeof deliveryId === 'string' && !this.isValidId(deliveryId)) return null;
    return this.findOne({ delivery: deliveryId }, options);
  }

  /** Look up an escrow by its Soroban contract id. */
  async findByContractId(
    contractId: string,
    options?: ReadOptions<IEscrow>,
  ): Promise<IEscrow | null> {
    return this.findOne({ contractId }, options);
  }

  /** All escrows currently in a given lifecycle state. */
  async findByStatus(status: EscrowStatus, options?: ReadOptions<IEscrow>): Promise<IEscrow[]> {
    return this.find({ status }, options);
  }

  /**
   * Whether a transaction hash has already been recorded on any escrow.
   *
   * Chain indexers can deliver the same event more than once; this is the
   * idempotency check that keeps a replay from double-appending.
   */
  async transactionHashExists(hash: string): Promise<boolean> {
    return this.exists({ 'transactions.hash': hash });
  }

  /**
   * Append an on-chain transaction to an escrow's audit trail.
   *
   * `$addToSet` on the hash would not work here because transactions are
   * subdocuments, so callers should pair this with
   * {@link transactionHashExists} when replay is possible.
   */
  async appendTransaction(
    id: string,
    transaction: IEscrowTransaction,
    options?: WriteOptions,
  ): Promise<IEscrow | null> {
    return this.updateById(id, { $push: { transactions: transaction } }, options);
  }

  /**
   * Move an escrow between lifecycle states, asserting the prior state.
   *
   * @param expectedFrom - States the escrow may legally be in for this move.
   * @param timestampField - Lifecycle timestamp to stamp with the current time.
   * @returns The updated escrow, or `null` if it was not in `expectedFrom`.
   */
  async transitionStatus(
    id: string,
    expectedFrom: EscrowStatus[],
    to: EscrowStatus,
    timestampField?: 'lockedAt' | 'releasedAt' | 'refundedAt' | 'flaggedAt' | 'resolvedAt',
    options?: WriteOptions,
  ): Promise<IEscrow | null> {
    if (!this.isValidId(id)) return null;

    const set: Record<string, unknown> = { status: to };
    if (timestampField) set[timestampField] = new Date();

    return this.updateOne({ _id: id, status: { $in: expectedFrom } }, { $set: set }, options);
  }
}

export const escrowRepository = new EscrowRepository();
