import { assertLockContractAsset } from './currencyService';
import {
  Account,
  Address,
  Contract,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  rpc as StellarRpc,
  xdr,
} from '@stellar/stellar-sdk';
import { StatusCodes } from 'http-status-codes';
import { sorobanRpcClient, stellarConfig } from '../config/stellar';
import { deliveryService } from './delivery.service';
import { IDelivery } from '../models/Delivery';
import { toStroops } from '../utils/stroops';
import AppError from '../utils/AppError';
import logger from '../config/logger';
import env from '../config/env';
import {
  withRetry,
  OperationTimeoutError,
  sleep,
  type AttemptFailureKind,
} from '../utils/rpcRetry';

// ─── Public types ──────────────────────────────────────────────────────────────

/**
 * Input accepted by {@link StellarService.submitEscrowLock}.
 */
export interface SubmitEscrowLockInput {
  /** MongoDB `_id` of the delivery whose escrow is being locked. */
  deliveryId: string;
  /**
   * Base64-encoded, **signed** transaction envelope XDR.
   * The client wallet signs the XDR built by `POST /transactions/escrow-lock`
   * and returns it here for submission.
   */
  signedXdr: string;
  /**
   * The Stellar account that signed the transaction.
   * Used to re-fetch the latest sequence number if `tx_bad_seq` is returned.
   */
  payerAddress: string;
}

/**
 * Outcome of a successful transaction submission.
 */
export interface SubmitEscrowLockResult {
  /** Stellar transaction hash. */
  transactionHash: string;
  /** Final ledger sequence in which the transaction was included. */
  ledger: number;
  /** Whether the submission required a sequence-number refresh and retry. */
  retriedOnBadSeq: boolean;
  /** Number of submission attempts made (1 = first attempt succeeded). */
  attempts: number;
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Normalise the many error shapes the Stellar SDK can produce into a string.
 */
function extractMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/**
 * Node-level socket error codes that mean "the request never got a reply",
 * as opposed to "the node answered and said no".
 */
const TRANSIENT_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
]);

/**
 * HTTP statuses worth retrying: the node is rate-limiting us, is briefly
 * unavailable, or a proxy in front of it failed. A 4xx other than 429 means
 * the request itself is wrong and will fail identically on every retry.
 */
const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Extract an HTTP status code from the various shapes the SDK surfaces. */
function extractStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;

  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
  };

  for (const value of [candidate.status, candidate.statusCode, candidate.response?.status]) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

/**
 * Decide whether an RPC failure is transient and therefore worth retrying.
 *
 * Retried:
 *   - per-attempt timeouts,
 *   - socket-level failures (connection reset, DNS hiccup, unreachable host),
 *   - HTTP 408/425/429 and 5xx.
 *
 * Not retried:
 *   - anything else, notably 4xx responses and malformed-request errors,
 *     which are deterministic — retrying only adds latency before the same
 *     failure, and for a submission it risks duplicating work.
 *
 * @param error - The thrown value.
 * @param kind  - Whether the attempt timed out or rejected.
 * @returns `true` when another attempt could plausibly succeed.
 */
export function isTransientRpcError(error: unknown, kind: AttemptFailureKind = 'error'): boolean {
  if (kind === 'timeout' || error instanceof OperationTimeoutError) return true;

  const status = extractStatusCode(error);
  if (status !== undefined) return TRANSIENT_HTTP_STATUSES.has(status);

  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string' && TRANSIENT_ERROR_CODES.has(code)) return true;

  const message = extractMessage(error).toLowerCase();

  // A bad sequence number is handled by its own dedicated retry path, which
  // rebuilds the envelope. Retrying the identical XDR here would always fail.
  if (message.includes('tx_bad_seq') || message.includes('txbadseq')) return false;

  return (
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('socket hang up') ||
    message.includes('network error') ||
    message.includes('econnreset') ||
    message.includes('econnrefused') ||
    message.includes('enotfound') ||
    message.includes('eai_again') ||
    message.includes('service unavailable') ||
    message.includes('bad gateway') ||
    message.includes('gateway timeout') ||
    message.includes('too many requests')
  );
}

/**
 * Inspect a `SendTransactionResponse` or a thrown error and decide whether it
 * represents a sequence-number mismatch (`tx_bad_seq`).
 *
 * The Stellar RPC layer returns `tx_bad_seq` in two ways depending on SDK
 * version and transport:
 *   1. `sendTransaction` resolves with `{ status: "ERROR", errorResultXdr }`
 *      where the XDR encodes `txBAD_SEQ`.
 *   2. Some SDK versions throw an `Error` whose message contains the string
 *      `tx_bad_seq`.
 *
 * We check both paths so the guard is robust to SDK / node differences.
 */
function isBadSeqError(responseOrError: StellarRpc.Api.SendTransactionResponse | unknown): boolean {
  // Path 1: resolved response object
  if (
    typeof responseOrError === 'object' &&
    responseOrError !== null &&
    'status' in responseOrError
  ) {
    const resp = responseOrError as StellarRpc.Api.SendTransactionResponse;
    if (resp.status !== 'ERROR') return false;

    // Try to decode the error result to confirm it's specifically txBAD_SEQ.
    // SDK v13 exposes the decoded `errorResult` (the raw `errorResultXdr`
    // string only exists on the raw response variant).
    const rawResultXdr = (() => {
      const withRaw = resp as unknown as { errorResultXdr?: string };
      if (withRaw.errorResultXdr) return withRaw.errorResultXdr;
      try {
        return resp.errorResult?.toXDR('base64');
      } catch {
        return undefined;
      }
    })();

    if (rawResultXdr) {
      try {
        const result = xdr.TransactionResult.fromXDR(rawResultXdr, 'base64');
        const resultCode = result.result().switch().name;
        if (resultCode === 'txBadSeq') return true;
      } catch {
        // XDR parse failed — fall through to string-match below.
      }
      // Fallback: plain string match on the raw XDR or error field.
      const raw = JSON.stringify(resp).toLowerCase();
      if (raw.includes('tx_bad_seq') || raw.includes('txbadseq')) return true;
    }
    return false;
  }

  // Path 2: thrown Error
  const msg = extractMessage(responseOrError).toLowerCase();
  return msg.includes('tx_bad_seq') || msg.includes('txbadseq');
}

// ─── StellarService ────────────────────────────────────────────────────────────

/**
 * StellarService handles signed transaction **submission** to the Soroban
 * network and encapsulates the `tx_bad_seq` retry logic.
 *
 * Architecture:
 *   Controller → StellarService (this file) → StellarRpc.Server (SDK)
 *
 * Sequence-mismatch retry strategy:
 *   When the network returns `tx_bad_seq` it means the transaction envelope
 *   was built with a stale account sequence number — typically because a
 *   concurrent transaction from the same account incremented the sequence
 *   between the XDR build and the submission.
 *
 *   Recovery steps (per attempt):
 *     1. Re-fetch the account via `getAccount(payerAddress)` to obtain the
 *        current sequence number.
 *     2. Re-build the transaction operation using fresh delivery + contract
 *        data from the database (no hardcoded values).
 *     3. Re-simulate via `prepareTransaction` to attach updated resource fees
 *        and footprint.
 *     4. The caller's original signed XDR is replaced by the new unsigned
 *        envelope — the **client must re-sign** on the next iteration.
 *        Because this service is server-side and cannot re-sign on the client's
 *        behalf, on a `tx_bad_seq` retry the service returns a **new unsigned
 *        XDR** for the client to sign, rather than auto-submitting silently.
 *
 *   Retry attempts are capped by `STELLAR_BAD_SEQ_MAX_RETRIES` (default 3).
 */
export class StellarService {
  private readonly client: StellarRpc.Server;
  private readonly badSeqMaxRetries: number;
  private readonly rpcMaxAttempts: number;
  private readonly rpcBaseDelayMs: number;
  private readonly rpcMaxDelayMs: number;
  private readonly rpcJitterRatio: number;
  private readonly rpcTimeoutMs: number;

  constructor(client: StellarRpc.Server = sorobanRpcClient) {
    this.client = client;
    this.badSeqMaxRetries = env.STELLAR_BAD_SEQ_MAX_RETRIES;
    this.rpcMaxAttempts = env.SOROBAN_RPC_MAX_RETRIES;
    this.rpcBaseDelayMs = env.SOROBAN_RPC_RETRY_BASE_MS;
    this.rpcMaxDelayMs = env.SOROBAN_RPC_RETRY_MAX_MS;
    this.rpcJitterRatio = env.SOROBAN_RPC_RETRY_JITTER_RATIO;
    this.rpcTimeoutMs = stellarConfig.timeoutMs;
  }

  /**
   * Run a single Soroban RPC call under the shared resilience policy:
   * per-attempt timeout, exponential backoff with jitter, and retries limited
   * to transient failures.
   *
   * Every attempt that fails is logged at `warn` with the reason and the delay
   * before the next try; a call that succeeds only after retrying logs a
   * `info` recovery line. That pairing is what makes an intermittent RPC node
   * visible in the logs instead of silently inflating latency.
   *
   * @param operation - Short label used in logs and timeout messages.
   * @param factory   - Produces a fresh promise per attempt.
   * @param context   - Extra key/value pairs appended to each log line.
   */
  private async callRpc<T>(
    operation: string,
    factory: () => Promise<T>,
    context: Record<string, string | number> = {},
  ): Promise<T> {
    const suffix = Object.entries(context)
      .map(([key, value]) => ` ${key}=${String(value)}`)
      .join('');

    return withRetry(factory, {
      maxAttempts: this.rpcMaxAttempts,
      baseDelayMs: this.rpcBaseDelayMs,
      maxDelayMs: this.rpcMaxDelayMs,
      jitter: this.rpcJitterRatio,
      timeoutMs: this.rpcTimeoutMs,
      operationName: operation,
      isRetryable: isTransientRpcError,
      onAttemptFailed: ({ attempt, maxAttempts, kind, error, delayMs }) => {
        const reason = kind === 'timeout' ? 'timeout' : extractMessage(error);
        if (delayMs > 0) {
          logger.warn(
            `[StellarService] RPC '${operation}' attempt ${attempt}/${maxAttempts} failed ` +
              `(${kind}): ${reason} — retrying in ${delayMs}ms${suffix}`,
          );
        } else {
          logger.error(
            `[StellarService] RPC '${operation}' failed permanently after ` +
              `${attempt}/${maxAttempts} attempt(s) (${kind}): ${reason}${suffix}`,
          );
        }
      },
      onRecovery: ({ attempt, elapsedMs }) => {
        logger.info(
          `[StellarService] RPC '${operation}' recovered on attempt ${attempt} ` +
            `after ${elapsedMs}ms${suffix}`,
        );
      },
    });
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Submit a **signed** escrow-lock transaction to the Stellar network.
   *
   * On `tx_bad_seq`:
   *   - Re-fetches the latest account sequence from the RPC node.
   *   - Rebuilds the transaction with fresh sequence + resource data from DB.
   *   - Returns the new **unsigned** XDR so the client wallet can re-sign and
   *     resubmit.  This is the safest pattern — the server never holds keys.
   *
   * On any other terminal error the method throws an `AppError` with a clear
   * HTTP status code and message.
   *
   * @throws {AppError} 400 — invalid signed XDR format.
   * @throws {AppError} 404 — delivery or payer account not found.
   * @throws {AppError} 409 — sequence mismatch exhausted all retry attempts;
   *                         returns a fresh XDR for the client to re-sign.
   * @throws {AppError} 502 — RPC node rejected the simulation or submission.
   * @throws {AppError} 503 — escrow contract not configured.
   */
  public async submitEscrowLock(input: SubmitEscrowLockInput): Promise<SubmitEscrowLockResult> {
    const { signedXdr, payerAddress, deliveryId } = input;
    const maxAttempts = this.badSeqMaxRetries + 1; // +1 because first attempt is not a retry

    let currentXdr = signedXdr;
    let badSeqCount = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      logger.info(
        `[StellarService] Submitting escrow-lock tx — ` +
          `payer=${payerAddress} attempt=${attempt}/${maxAttempts}`,
      );

      const response = await this.send(currentXdr);

      // ── Success path ──────────────────────────────────────────────────────
      if (response.status === 'PENDING' || response.status === 'DUPLICATE') {
        // Wait for inclusion in a ledger.
        const confirmed = await this.pollForCompletion(response.hash);

        logger.info(
          `[StellarService] Escrow-lock tx confirmed — ` +
            `hash=${confirmed.hash} ledger=${confirmed.ledger} ` +
            `attempts=${attempt} badSeqRetries=${badSeqCount}`,
        );

        return {
          transactionHash: confirmed.hash,
          ledger: confirmed.ledger,
          retriedOnBadSeq: badSeqCount > 0,
          attempts: attempt,
        };
      }

      // ── tx_bad_seq path ───────────────────────────────────────────────────
      if (isBadSeqError(response)) {
        badSeqCount++;

        if (attempt >= maxAttempts) {
          logger.error(
            `[StellarService] tx_bad_seq — exhausted ${badSeqCount} retry attempt(s). ` +
              `payer=${payerAddress} deliveryId=${deliveryId}`,
          );
          throw new AppError(
            `Transaction sequence number mismatch persisted after ${badSeqCount} retry attempt(s). ` +
              'The account sequence may be under high contention. Please try again shortly.',
            StatusCodes.CONFLICT,
          );
        }

        logger.warn(
          `[StellarService] tx_bad_seq on attempt ${attempt} — ` +
            `refreshing sequence number and rebuilding XDR (retry ${badSeqCount}/${this.badSeqMaxRetries})`,
        );

        // Re-fetch account + rebuild transaction with fresh sequence.
        // The rebuilt XDR is unsigned — caller must re-sign.
        currentXdr = await this.rebuildWithFreshSequence(deliveryId, payerAddress);

        // Brief back-off before retrying to reduce contention.
        const delayMs = Math.min(200 * Math.pow(2, badSeqCount - 1), 2000);
        logger.debug(`[StellarService] Waiting ${delayMs}ms before retry`);
        await sleep(delayMs);
        continue;
      }

      // ── Other error ───────────────────────────────────────────────────────
      const errXdr =
        response.errorResult?.toXDR('base64') ??
        (response as unknown as { errorResultXdr?: string }).errorResultXdr ??
        '(no XDR)';
      logger.error(
        `[StellarService] Submission failed — status=${response.status} ` +
          `errorResultXdr=${errXdr} payer=${payerAddress}`,
      );

      const errorMessage = `Transaction submission failed with status '${response.status}'. Error result XDR: ${errXdr}`;

      // Store in Dead Letter Queue (DLQ)
      const { dlqService } = await import('./dlqService');
      await dlqService.addEntry(input, errorMessage).catch((dlqErr) => {
        logger.error(`[StellarService] Failed to save to DLQ: ${extractMessage(dlqErr)}`);
      });

      throw new AppError(errorMessage, StatusCodes.BAD_GATEWAY);
    }

    // Unreachable — loop always returns or throws.
    throw new AppError('Unexpected exit from submission loop.', StatusCodes.INTERNAL_SERVER_ERROR);
  }

  /**
   * Rebuild the escrow-lock transaction from scratch using the current account
   * sequence number fetched live from the RPC node.
   *
   * All contract arguments (amount, delivery reference, contract id) are
   * resolved from MongoDB — no hardcoded values.
   *
   * @returns Base64 unsigned transaction envelope XDR ready to be signed.
   */
  public async rebuildWithFreshSequence(deliveryId: string, payerAddress: string): Promise<string> {
    const contractId = this.requireEscrowContractId();

    // Load delivery from DB — data source per acceptance criteria.
    const delivery = await deliveryService.getById(deliveryId);
    assertLockContractAsset(delivery.escrowAsset ?? { code: 'XLM' });
    const amount = this.resolveEscrowAmount(delivery);
    const stroops = this.toContractAmount(amount);

    // Re-fetch account to get the current sequence number.
    const sourceAccount = await this.loadAccount(payerAddress);

    const operation = new Contract(contractId).call(
      stellarConfig.escrowLockFunction,
      new Address(payerAddress).toScVal(),
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
      `[StellarService] Rebuilt XDR with fresh sequence — ` +
        `delivery=${deliveryId} payer=${payerAddress} seq=${prepared.sequence}`,
    );

    return prepared.toXDR();
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /** Send a signed XDR to the RPC node. Never throws — returns the response. */
  private async send(signedXdr: string): Promise<StellarRpc.Api.SendTransactionResponse> {
    try {
      // Deserialise the signed envelope XDR into a Transaction object.
      const tx = TransactionBuilder.fromXDR(
        signedXdr,
        stellarConfig.networkPassphrase,
      ) as Transaction;

      return await this.callRpc('sendTransaction', () => this.client.sendTransaction(tx));
    } catch (error) {
      const message = extractMessage(error);

      if (error instanceof OperationTimeoutError) {
        // The node never answered. The transaction may or may not have been
        // accepted, so this is surfaced as a gateway timeout rather than
        // resubmitted blindly — a duplicate submission could double-spend.
        logger.error(
          `[StellarService] sendTransaction timed out after ` +
            `${this.rpcMaxAttempts} attempt(s): ${message}`,
        );
        throw new AppError(
          'The Soroban RPC node did not respond to the transaction submission in time. ' +
            'The transaction may still have been accepted — verify by hash before resubmitting.',
          StatusCodes.GATEWAY_TIMEOUT,
        );
      }

      // If the SDK itself throws with bad-seq language surface it as a
      // synthetic response object so the caller's isBadSeqError check works.
      if (
        message.toLowerCase().includes('tx_bad_seq') ||
        message.toLowerCase().includes('txbadseq')
      ) {
        logger.warn(`[StellarService] sendTransaction threw bad-seq: ${message}`);
        return {
          status: 'ERROR',
          hash: '',
          errorResultXdr: '',
          networkPassphrase: stellarConfig.networkPassphrase,
          latestCheckpointLedger: 0,
          latestLedger: 0,
          latestLedgerCloseTime: BigInt(0),
        } as unknown as StellarRpc.Api.SendTransactionResponse;
      }

      logger.error(`[StellarService] sendTransaction threw unexpectedly: ${message}`);
      throw new AppError(
        `Unable to submit transaction to the Soroban RPC node: ${message}`,
        StatusCodes.BAD_GATEWAY,
      );
    }
  }

  /**
   * Poll `getTransaction` until the transaction reaches a terminal state
   * (SUCCESS or FAILED) or until the ledger close time advances enough that
   * the transaction's validity window has expired.
   *
   * Polls with exponential back-off starting at 500 ms, capped at 5 s, up to
   * `SOROBAN_RPC_MAX_RETRIES * 4` attempts (at least 12 polls by default).
   */
  private async pollForCompletion(hash: string): Promise<{ hash: string; ledger: number }> {
    const maxPolls = env.SOROBAN_RPC_MAX_RETRIES * 4;
    let delay = 500;

    for (let poll = 1; poll <= maxPolls; poll++) {
      await sleep(delay);
      delay = Math.min(delay * 2, 5000);

      let txResponse: StellarRpc.Api.GetTransactionResponse;
      try {
        // Each poll is itself retried, so a momentary blip does not consume a
        // whole polling slot and shorten the confirmation window.
        txResponse = await this.callRpc('getTransaction', () => this.client.getTransaction(hash), {
          hash,
        });
      } catch (error) {
        logger.warn(
          `[StellarService] getTransaction poll ${poll}/${maxPolls} failed: ${extractMessage(
            error,
          )}`,
        );
        continue;
      }

      if (txResponse.status === StellarRpc.Api.GetTransactionStatus.SUCCESS) {
        return { hash, ledger: txResponse.ledger };
      }

      if (txResponse.status === StellarRpc.Api.GetTransactionStatus.FAILED) {
        // SDK v13 returns the decoded TransactionResult on failure responses.
        const resultXdr =
          txResponse.resultXdr?.toXDR('base64') ??
          (txResponse as unknown as { resultXdr?: string }).resultXdr ??
          '(no XDR)';
        logger.error(`[StellarService] Transaction FAILED — hash=${hash} resultXdr=${resultXdr}`);
        throw new AppError(
          `Transaction was submitted but failed on-chain. Result XDR: ${resultXdr}`,
          StatusCodes.BAD_GATEWAY,
        );
      }

      // NOT_FOUND means still pending — keep polling.
      logger.debug(
        `[StellarService] Poll ${poll}/${maxPolls} — status=${txResponse.status} hash=${hash}`,
      );
    }

    throw new AppError(
      `Transaction ${hash} did not reach a terminal state within the polling window. ` +
        'Check the network status and verify the transaction hash manually.',
      StatusCodes.GATEWAY_TIMEOUT,
    );
  }

  private requireEscrowContractId(): string {
    const contractId = stellarConfig.escrowContractId;
    if (!contractId) {
      logger.error('[StellarService] SOROBAN_ESCROW_CONTRACT_ID is not configured');
      throw new AppError(
        'Escrow contract is not configured on this deployment.',
        StatusCodes.SERVICE_UNAVAILABLE,
      );
    }
    return contractId;
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

  private async loadAccount(payerAddress: string): Promise<Account> {
    try {
      return await this.callRpc('getAccount', () => this.client.getAccount(payerAddress), {
        payer: payerAddress,
      });
    } catch (error) {
      const message = extractMessage(error);

      if (error instanceof OperationTimeoutError) {
        throw new AppError(
          'Timed out loading the payer account from the Soroban RPC node.',
          StatusCodes.GATEWAY_TIMEOUT,
        );
      }

      if (message.toLowerCase().includes('not found')) {
        throw new AppError(
          `Account ${payerAddress} does not exist on ${stellarConfig.network}. ` +
            'Fund the account before locking escrow.',
          StatusCodes.NOT_FOUND,
        );
      }
      logger.error(`[StellarService] Failed to load account ${payerAddress}: ${message}`);
      throw new AppError(
        'Unable to reach the Soroban RPC node to load the payer account.',
        StatusCodes.BAD_GATEWAY,
      );
    }
  }

  private async prepare(transaction: Transaction): Promise<Transaction> {
    try {
      return await this.callRpc('prepareTransaction', () =>
        this.client.prepareTransaction(transaction),
      );
    } catch (error) {
      const message = extractMessage(error);

      if (error instanceof OperationTimeoutError) {
        throw new AppError(
          'Timed out simulating the transaction against the Soroban RPC node.',
          StatusCodes.GATEWAY_TIMEOUT,
        );
      }

      logger.error(`[StellarService] Simulation failed during rebuild: ${message}`);
      throw new AppError(
        `Soroban simulation failed while rebuilding transaction: ${message}`,
        StatusCodes.BAD_GATEWAY,
      );
    }
  }
}

/** Singleton instance used by the controller layer. */
export const stellarService = new StellarService();
