/**
 * Provider-agnostic Soroban RPC contract.
 *
 * Services that talk to the Stellar network (stellarService, sorobanService,
 * transactionService, indexerService, escrow handlers) depend only on this
 * interface, so the concrete `rpc.Server` from `@stellar/stellar-sdk` can be
 * swapped for a fake in unit tests — no network, no credentials, no module
 * mocking. It mirrors the `IPushProvider` pattern used for push notifications.
 *
 * Method signatures intentionally match `rpc.Server` 1:1 (returning the SDK's
 * own parsed response types), so the SDK adapter below is a trivial delegate
 * and fakes remain structurally compatible with the real client.
 */

import type {
  Account,
  FeeBumpTransaction,
  Transaction,
  rpc as StellarRpc,
} from '@stellar/stellar-sdk';

/** Request shape for contract-event queries (`rpc.Server.GetEventsRequest`). */
export type SorobanGetEventsRequest = StellarRpc.Server.GetEventsRequest;

/**
 * Transaction returned by `prepareTransaction`.
 * Derived from the SDK's own signature so it can never drift.
 */
export type PreparedTransaction = Awaited<ReturnType<StellarRpc.Server['prepareTransaction']>>;

/** Methods consumed from the Soroban RPC node, extracted behind an interface. */
export interface ISorobanRpcClient {
  /** Fetch the current sequence/attributes of an on-network account. */
  getAccount(address: string): Promise<Account>;
  /** Liveness probe of the RPC node. */
  getHealth(): Promise<StellarRpc.Api.GetHealthResponse>;
  /** Fetch a transaction's terminal state by hash. */
  getTransaction(hash: string): Promise<StellarRpc.Api.GetTransactionResponse>;
  /** Query contract events emitted from a ledger onwards. */
  getEvents(request: SorobanGetEventsRequest): Promise<StellarRpc.Api.GetEventsResponse>;
  /** Header metadata for the newest ledger on the network. */
  getLatestLedger(): Promise<StellarRpc.Api.GetLatestLedgerResponse>;
  /** Metadata (passphrase, protocol version) of the connected network. */
  getNetwork(): Promise<StellarRpc.Api.GetNetworkResponse>;
  /** Simulate a transaction and attach footprint/fees/resource data. */
  prepareTransaction(tx: Transaction | FeeBumpTransaction): Promise<PreparedTransaction>;
  /** Submit a signed transaction envelope to the network. */
  sendTransaction(
    tx: Transaction | FeeBumpTransaction,
  ): Promise<StellarRpc.Api.SendTransactionResponse>;
}
