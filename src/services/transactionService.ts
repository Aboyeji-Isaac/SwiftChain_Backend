import { assertLockContractAsset } from './currencyService';
import {
  Account,
  Address,
  Contract,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  rpc as StellarRpc,
} from '@stellar/stellar-sdk';
import { StatusCodes } from 'http-status-codes';
import CircuitBreaker from 'opossum';
import { sorobanRpcClient, stellarConfig } from '../config/stellar';
import { deliveryService } from './delivery.service';
import { DeliveryStatus, IDelivery } from '../models/Delivery';
import { fromStroops, toStroops } from '../utils/stroops';
import AppError from '../utils/AppError';
import logger from '../config/logger';
import env from '../config/env';
import { createCircuitBreaker, fireWithBreaker } from '../utils/circuitBreaker';
import { DegradedLedgerResult } from '../blockchain/soroban.service';

/** Input accepted by {@link TransactionService.buildEscrowLockXdr}. */
export interface EscrowLockXdrInput {
  deliveryId: string;
  payerAddress: string;
}

/** Unsigned transaction envelope returned to the client wallet. */
export interface EscrowLockXdrResult {
  xdr: string;
  network: string;
  networkPassphrase: string;
  contractId: string;
  contractFunction: string;
  sourceAccount: string;
  sequence: string;
  fee: string;
  validUntil: number;
  delivery: {
    id: string;
    deliveryId?: string;
    trackingNumber?: string;
    status: DeliveryStatus;
  };
  amount: {
    value: number;
    stroops: string;
    formatted: string;
  };
}

/** Normalise varied SDK error shapes into a plain message string. */
function extractMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/** Delivery states for which locking new escrow funds makes no sense. */
const NON_LOCKABLE_STATUSES: ReadonlySet<DeliveryStatus> = new Set([
  DeliveryStatus.COMPLETED,
  DeliveryStatus.CANCELLED,
]);

/**
 * TransactionService builds unsigned Soroban transactions on behalf of the
 * frontend, now protected by a circuit breaker on every RPC call.
 *
 * Circuit-breaker strategy:
 *   The two RPC calls made here — `getAccount` and `prepareTransaction` — each
 *   go through the shared `soroban-rpc-tx` circuit breaker.  When the breaker
 *   is OPEN both calls immediately throw a typed `AppError(503)` so the
 *   controller can surface a clean "service temporarily unavailable" response
 *   without waiting for a TCP timeout.
 */
export class TransactionService {
  private readonly client: StellarRpc.Server;
  private readonly breaker: CircuitBreaker<[() => Promise<unknown>], unknown>;

  constructor(client: StellarRpc.Server = sorobanRpcClient) {
    this.client = client;

    // A dedicated breaker for transaction-building RPC calls.  We use a
    // separate instance (not the shared soroban-rpc one from SorobanService)
    // so that heavy escrow-lock simulation failures don't affect the
    // lighter connectivity/health checks, and vice-versa.
    this.breaker = createCircuitBreaker<[() => Promise<unknown>], unknown>(
      {
        name: 'soroban-rpc-tx',
        errorThresholdPercentage: env.CB_SOROBAN_ERROR_THRESHOLD_PERCENTAGE,
        rollingWindowMs: env.CB_SOROBAN_ROLLING_WINDOW_MS,
        resetTimeoutMs: env.CB_SOROBAN_RESET_TIMEOUT_MS,
        volumeThreshold: env.CB_SOROBAN_VOLUME_THRESHOLD,
        timeoutMs: env.CB_SOROBAN_TIMEOUT_MS,
      },
      // Fallback: surface a 503 immediately rather than hanging.
      (): DegradedLedgerResult => ({
        degraded: true,
        reason:
          'Soroban RPC circuit is OPEN — unable to reach the node for ' +
          'transaction simulation. Please retry in a moment.',
      }),
    );
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Build an unsigned XDR for the escrow-lock contract invocation.
   *
   * @throws {AppError} 503 when the escrow contract id is not configured.
   * @throws {AppError} 503 when the Soroban RPC circuit is OPEN.
   * @throws {AppError} 404 when the delivery or payer account is not found.
   * @throws {AppError} 409 when the delivery status prevents locking.
   * @throws {AppError} 422 when the delivery carries no valid escrow amount.
   * @throws {AppError} 502 when the RPC simulation rejects the transaction.
   */
  public async buildEscrowLockXdr(input: EscrowLockXdrInput): Promise<EscrowLockXdrResult> {
    const contractId = this.requireEscrowContractId();
    const delivery = await deliveryService.getById(input.deliveryId);

    this.assertLockable(delivery);
    assertLockContractAsset(delivery.escrowAsset ?? { code: 'XLM' });
    const amount = this.resolveEscrowAmount(delivery);
    const stroops = this.toContractAmount(amount);

    const sourceAccount = await this.loadAccount(input.payerAddress);

    const operation = new Contract(contractId).call(
      stellarConfig.escrowLockFunction,
      new Address(input.payerAddress).toScVal(),
      nativeToScVal(this.escrowReference(delivery), { type: 'string' }),
      nativeToScVal(stroops, { type: 'i128' }),
    );

    const transaction = new TransactionBuilder(sourceAccount, {
      fee: stellarConfig.baseFee,
      networkPassphrase: stellarConfig.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(stellarConfig.transactionTimeoutSeconds)
      .build();

    const prepared = await this.prepare(transaction);

    logger.info(
      `[TransactionService] Escrow-lock XDR built — delivery=${String(delivery._id)} ` +
        `payer=${input.payerAddress} amount=${amount} stroops=${stroops.toString()} ` +
        `fee=${prepared.fee}`,
    );

    return {
      xdr: prepared.toXDR(),
      network: stellarConfig.network,
      networkPassphrase: stellarConfig.networkPassphrase,
      contractId,
      contractFunction: stellarConfig.escrowLockFunction,
      sourceAccount: input.payerAddress,
      sequence: prepared.sequence,
      fee: prepared.fee,
      validUntil: Number(prepared.timeBounds?.maxTime ?? 0),
      delivery: {
        id: String(delivery._id),
        deliveryId: delivery.deliveryId,
        trackingNumber: delivery.trackingNumber,
        status: delivery.status,
      },
      amount: {
        value: amount,
        stroops: stroops.toString(),
        formatted: fromStroops(stroops),
      },
    };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private requireEscrowContractId(): string {
    const contractId = stellarConfig.escrowContractId;
    if (!contractId) {
      logger.error('[TransactionService] SOROBAN_ESCROW_CONTRACT_ID is not configured');
      throw new AppError(
        'Escrow contract is not configured on this deployment.',
        StatusCodes.SERVICE_UNAVAILABLE,
      );
    }
    return contractId;
  }

  private assertLockable(delivery: IDelivery): void {
    if (NON_LOCKABLE_STATUSES.has(delivery.status)) {
      throw new AppError(
        `Escrow cannot be locked for a delivery with status '${delivery.status}'.`,
        StatusCodes.CONFLICT,
      );
    }
  }

  private resolveEscrowAmount(delivery: IDelivery): number {
    const amount = delivery.escrowAmount;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      throw new AppError(
        'Delivery does not define a positive escrow amount.',
        StatusCodes.UNPROCESSABLE_ENTITY,
      );
    }
    return amount;
  }

  private toContractAmount(amount: number): bigint {
    try {
      return toStroops(amount);
    } catch (error) {
      throw new AppError(
        `Delivery escrow amount cannot be represented on-chain: ${extractMessage(error)}`,
        StatusCodes.UNPROCESSABLE_ENTITY,
      );
    }
  }

  private escrowReference(delivery: IDelivery): string {
    return delivery.deliveryId?.trim() || String(delivery._id);
  }

  /**
   * Load the payer account via the circuit-breaker-protected RPC client.
   */
  private async loadAccount(payerAddress: string): Promise<Account> {
    const result = await fireWithBreaker(
      this.breaker as CircuitBreaker<[() => Promise<Account>], Account | DegradedLedgerResult>,
      (action: () => Promise<Account>) => action(),
      () => this.client.getAccount(payerAddress),
    );

    // Circuit is OPEN — fallback was returned.
    if ((result as DegradedLedgerResult).degraded) {
      const reason = (result as DegradedLedgerResult).reason;
      logger.error(`[TransactionService] loadAccount circuit open: ${reason}`);
      throw new AppError(reason, StatusCodes.SERVICE_UNAVAILABLE);
    }

    return result as Account;
  }

  /**
   * Simulate and assemble the transaction via the circuit-breaker-protected
   * RPC client.
   */
  private async prepare(transaction: Transaction): Promise<Transaction> {
    const result = await fireWithBreaker(
      this.breaker as CircuitBreaker<
        [() => Promise<Transaction>],
        Transaction | DegradedLedgerResult
      >,
      (action: () => Promise<Transaction>) => action(),
      () => this.client.prepareTransaction(transaction),
    ).catch((error: unknown) => {
      // Re-catch errors that escape the fallback (should not occur).
      const message = extractMessage(error);
      logger.error(`[TransactionService] Escrow-lock simulation failed: ${message}`);
      throw new AppError(
        `Soroban simulation failed for the escrow-lock invocation: ${message}`,
        StatusCodes.BAD_GATEWAY,
      );
    });

    // Circuit is OPEN — fallback was returned.
    if ((result as DegradedLedgerResult).degraded) {
      const reason = (result as DegradedLedgerResult).reason;
      logger.error(`[TransactionService] prepare circuit open: ${reason}`);
      throw new AppError(reason, StatusCodes.SERVICE_UNAVAILABLE);
    }

    return result as Transaction;
  }
}

/** Singleton instance used by the controller layer. */
export const transactionService = new TransactionService();
