# Stellar / Soroban Integration Guide

## Overview

SwiftChain uses Stellar Soroban RPC for escrow smart-contract integration.

The primary flow is:

```text
Client wallet
    |
    | request unsigned escrow XDR
    v
TransactionService
    |
    | get account + build contract call
    v
Soroban RPC
    |
    | prepare transaction
    v
Unsigned XDR
    |
    | client signs
    v
StellarService
    |
    | submit signed XDR
    v
Soroban RPC
    |
    v
Ledger confirmation
    |
    v
Indexer / Event ingestion
```

Primary implementation files:

```text
src/config/stellar.ts
src/config/env.ts
src/blockchain/soroban.service.ts
src/services/transactionService.ts
src/services/stellarService.ts
src/utils/stroops.ts
src/utils/rpcRetry.ts
src/utils/circuitBreaker.ts
```

---

# Network Configuration

The Stellar configuration is resolved by `src/config/stellar.ts`.

Supported network aliases:

```text
mainnet
testnet
futurenet
```

Environment variables:

```text
STELLAR_NETWORK
SOROBAN_RPC_URL
STELLAR_NETWORK_PASSPHRASE
SOROBAN_RPC_TIMEOUT_MS
SOROBAN_ESCROW_CONTRACT_ID
SOROBAN_ESCROW_LOCK_FUNCTION
STELLAR_BASE_FEE
STELLAR_TRANSACTION_TIMEOUT_SECONDS
```

Defaults:

```text
STELLAR_NETWORK=testnet
SOROBAN_RPC_TIMEOUT_MS=10000
SOROBAN_ESCROW_LOCK_FUNCTION=lock_escrow
STELLAR_BASE_FEE=100
STELLAR_TRANSACTION_TIMEOUT_SECONDS=300
```

If no RPC URL is supplied, the application resolves the default RPC URL for the configured network.

The configured passphrase is also resolved from the known Stellar network when `STELLAR_NETWORK_PASSPHRASE` is empty.

---

# Default Soroban RPC URLs

```text
mainnet:
https://soroban-mainnet.stellar.org

testnet:
https://soroban-testnet.stellar.org

futurenet:
https://rpc-futurenet.stellar.org
```

A custom endpoint can be supplied through:

```text
SOROBAN_RPC_URL
```

---

# Escrow Contract

The contract identifier is configured through:

```text
SOROBAN_ESCROW_CONTRACT_ID
```

The value is validated as a Soroban contract identifier during Stellar configuration initialization.

The contract function is configured through:

```text
SOROBAN_ESCROW_LOCK_FUNCTION
```

Default:

```text
lock_escrow
```

---

# Soroban RPC Resilience

`SorobanService` wraps RPC operations with:

1. Exponential-backoff retry.
2. Retry limits.
3. Request timeout handling.
4. Opossum circuit breaking.
5. Degraded responses while the circuit is open.

Configuration:

```text
SOROBAN_RPC_MAX_RETRIES
SOROBAN_RPC_RETRY_BASE_MS
SOROBAN_RPC_RETRY_MAX_MS
```

Circuit-breaker configuration:

```text
CB_SOROBAN_ERROR_THRESHOLD_PERCENTAGE
CB_SOROBAN_ROLLING_WINDOW_MS
CB_SOROBAN_RESET_TIMEOUT_MS
CB_SOROBAN_VOLUME_THRESHOLD
CB_SOROBAN_TIMEOUT_MS
```

---

# Circuit Breaker States

## CLOSED

Normal operating state.

RPC requests are allowed through and protected by retry logic.

```text
Request
  |
  v
Retry policy
  |
  v
Soroban RPC
```

---

## OPEN

The failure threshold has been reached.

RPC operations are short-circuited rather than continuously waiting for an unavailable RPC node.

The service can return a degraded result:

```ts
{
  degraded: true,
  reason: 'Soroban RPC circuit is OPEN ...'
}
```

---

## HALF-OPEN

After `CB_SOROBAN_RESET_TIMEOUT_MS`, the breaker allows a probe operation.

```text
OPEN
 |
 | reset timeout
 v
HALF-OPEN
 |
 +---- successful probe ----> CLOSED
 |
 +---- failed probe --------> OPEN
```

---

# Circuit Breaker Configuration

The breaker opens after the configured error threshold is exceeded within the rolling statistics window.

Default configuration represented by the environment schema includes:

```text
CB_SOROBAN_ERROR_THRESHOLD_PERCENTAGE=50
CB_SOROBAN_ROLLING_WINDOW_MS=30000
CB_SOROBAN_RESET_TIMEOUT_MS=60000
CB_SOROBAN_VOLUME_THRESHOLD=5
CB_SOROBAN_TIMEOUT_MS=10000
```

Transaction-building RPC operations use a dedicated `soroban-rpc-tx` breaker in `TransactionService`.

The general `SorobanService` uses its own Soroban RPC breaker.

This keeps transaction-building failures isolated from general RPC connectivity checks.

---

# RPC Retry Policy

The backend uses:

```text
SOROBAN_RPC_MAX_RETRIES
SOROBAN_RPC_RETRY_BASE_MS
SOROBAN_RPC_RETRY_MAX_MS
```

`StellarService` additionally applies:

```text
SOROBAN_RPC_RETRY_JITTER_RATIO
SOROBAN_RPC_TIMEOUT_MS
```

Transient failures include:

* request timeouts
* connection resets
* connection refused
* DNS failures
* unreachable hosts
* HTTP `408`
* HTTP `425`
* HTTP `429`
* HTTP `500`
* HTTP `502`
* HTTP `503`
* HTTP `504`

`tx_bad_seq` is handled separately and is not retried by simply resending the same transaction envelope.

---

# Building an Escrow-Lock XDR

Endpoint:

```text
POST /api/v1/transactions/escrow-lock
```

Request:

```json
{
  "deliveryId": "66f123456789abcdef123456",
  "payerAddress": "G..."
}
```

The backend:

1. Loads the delivery.
2. Validates that the delivery can be funded.
3. Validates the escrow asset.
4. Resolves the escrow amount.
5. Converts the amount to stroops.
6. Loads the payer account.
7. Builds the Soroban contract invocation.
8. Sets the network passphrase.
9. Sets the base fee.
10. Sets the transaction timeout.
11. Prepares the transaction through Soroban RPC.
12. Returns the unsigned XDR.

The backend does not hold the payer's secret key.

---

# Soroban Contract Invocation

The escrow lock operation is built using:

```ts
new Contract(contractId).call(
  stellarConfig.escrowLockFunction,
  new Address(input.payerAddress).toScVal(),
  nativeToScVal(this.escrowReference(delivery), { type: 'string' }),
  nativeToScVal(stroops, { type: 'i128' }),
);
```

The important contract arguments are:

```text
payer address
escrow reference
escrow amount in stroops
```

---

# Stroops Conversion

Stellar native amounts are represented on-chain as integer stroops.

SwiftChain uses:

```text
src/utils/stroops.ts
```

The escrow amount is converted using:

```ts
toStroops(amount)
```

The transaction service returns both the human-readable amount and the on-chain stroop representation.

Example:

```text
amount: 10.5
stroops: 105000000
```

The conversion must happen before constructing the Soroban `i128` contract argument.

Do not pass the human-readable decimal amount directly as the contract amount.

---

# Client Signing

The backend returns an unsigned XDR.

The client wallet signs it.

Conceptually:

```text
Backend
  |
  | unsigned XDR
  v
Client wallet
  |
  | signed XDR
  v
Backend submission endpoint
```

The backend never receives or stores the user's secret signing key.

---

# Transaction Submission

`StellarService.submitEscrowLock()` accepts:

```ts
interface SubmitEscrowLockInput {
  deliveryId: string;
  signedXdr: string;
  payerAddress: string;
}
```

The signed XDR is submitted to Soroban RPC.

Successful responses are followed by transaction polling until ledger inclusion is observed.

The service returns:

```ts
{
  transactionHash: string;
  ledger: number;
  retriedOnBadSeq: boolean;
  attempts: number;
}
```

---

# `tx_bad_seq` Recovery

A `tx_bad_seq` response indicates that the transaction used a stale account sequence.

SwiftChain does not simply resend the same XDR.

Recovery is:

```text
signed XDR
    |
    v
submitTransaction
    |
    +---- success ----> poll confirmation
    |
    +---- tx_bad_seq
              |
              v
        fetch latest account
              |
              v
        rebuild transaction
              |
              v
        prepare transaction
              |
              v
        return fresh unsigned XDR
              |
              v
        client re-signs
              |
              v
        resubmits
```

The retry count is limited by:

```text
STELLAR_BAD_SEQ_MAX_RETRIES
```

Default:

```text
3
```

The client must re-sign the newly generated XDR because the backend does not possess the payer's private key.

---

# DLQ / Unrecoverable Failures

Unrecoverable transaction-processing failures are handled by the transaction/service layer's failure workflow.

Where a failed transaction is recorded into the configured dead-letter queue, the DLQ record should preserve enough information for an administrator to inspect and retry the operation through the existing administrative DLQ workflow.

The important distinction is:

```text
Transient RPC failure
    -> retry automatically

tx_bad_seq
    -> rebuild XDR + client re-sign

Unrecoverable failure
    -> persist failure / DLQ
    -> administrative retry
```

---

# Connectivity Checks

`SorobanService.checkConnectivity()` checks:

```text
getHealth()
getLatestLedger()
```

The operations execute through the resilience layer.

The response includes:

```ts
{
  connected: boolean;
  network: string;
  networkPassphrase?: string;
  rpcUrl: string;
  status?: string;
  latestLedger?: number;
  checkedAt: string;
  latencyMs?: number;
  error?: string;
}
```

---

# End-to-End Escrow Flow

```text
┌─────────────────────┐
│ Merchant / Customer │
└──────────┬──────────┘
           │
           │ fund delivery
           v
┌─────────────────────┐
│ Client Wallet       │
└──────────┬──────────┘
           │
           │ request unsigned XDR
           v
┌─────────────────────┐
│ TransactionService  │
└──────────┬──────────┘
           │
           │ get account
           │ build escrow_lock
           │ prepare transaction
           v
┌─────────────────────┐
│ Soroban RPC         │
└──────────┬──────────┘
           │
           │ prepared unsigned XDR
           v
┌─────────────────────┐
│ Client Wallet       │
│ signs transaction   │
└──────────┬──────────┘
           │
           │ signed XDR
           v
┌─────────────────────┐
│ StellarService      │
└──────────┬──────────┘
           │
           │ submitTransaction
           v
┌─────────────────────┐
│ Stellar / Soroban   │
│ Network             │
└──────────┬──────────┘
           │
           │ ledger inclusion
           v
┌─────────────────────┐
│ Event / Indexer     │
│ Pipeline            │
└──────────┬──────────┘
           │
           │ indexed event
           v
┌─────────────────────┐
│ SwiftChain DB       │
└─────────────────────┘
```

---

# Important Environment Variables

```dotenv
STELLAR_NETWORK=testnet
SOROBAN_RPC_URL=
STELLAR_NETWORK_PASSPHRASE=
SOROBAN_RPC_TIMEOUT_MS=10000

SOROBAN_ESCROW_CONTRACT_ID=
SOROBAN_ESCROW_LOCK_FUNCTION=lock_escrow

STELLAR_BASE_FEE=100
STELLAR_TRANSACTION_TIMEOUT_SECONDS=300

SOROBAN_RPC_MAX_RETRIES=3
SOROBAN_RPC_RETRY_BASE_MS=250
SOROBAN_RPC_RETRY_MAX_MS=8000
STELLAR_BAD_SEQ_MAX_RETRIES=3

CB_SOROBAN_ERROR_THRESHOLD_PERCENTAGE=50
CB_SOROBAN_ROLLING_WINDOW_MS=30000
CB_SOROBAN_RESET_TIMEOUT_MS=60000
CB_SOROBAN_VOLUME_THRESHOLD=5
CB_SOROBAN_TIMEOUT_MS=10000
```

---

# Source of Truth

```text
src/config/stellar.ts
src/config/env.ts
src/blockchain/soroban.service.ts
src/services/transactionService.ts
src/services/stellarService.ts
src/utils/stroops.ts
src/utils/rpcRetry.ts
src/utils/circuitBreaker.ts
```
