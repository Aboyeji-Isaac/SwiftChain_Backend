# Asset handling

Delivery fees and escrow amounts each have their own asset identity (`{ code, issuer }`). Existing deliveries without an asset are treated as XLM. New deliveries default to XLM. A funded escrow must match its delivery's escrow asset and amount; no exchange rate or conversion is assumed. Fees and escrow balances must never be summed across different asset identities.

Set `USDC_ASSET_ISSUER` to the issuer for the deployed Stellar network to accept USDC records. To support a separate issued project token, set `NATIVE_TOKEN_CODE` and `NATIVE_TOKEN_ISSUER`. XLM has no issuer. Include `assetIssuer` with a non-XLM `/escrow/fund` request or `asset_issuer` in indexed events. Delivery creation accepts `deliveryFeeAsset` and `escrowAsset` objects.

**On-chain limitation:** The current Soroban lock function takes payer, delivery reference and amount only. Its XDR cannot select an asset. Transaction creation rejects non-XLM delivery escrow assets until an asset-aware contract ABI and corresponding call arguments are deployed. A configured asset can be recorded from a funded event, but this API does not exchange funds or claim that a non-XLM lock was created by its existing lock builder. Verify the deployed contract's asset behavior before enabling any new token in production.
