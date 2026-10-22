# Dynamic delivery fee estimates

`POST /api/v1/deliveries/fee-estimate` takes `{ "pickup": { "lat": 6.5, "lng": 3.3 }, "dropoff": { "lat": 6.6, "lng": 3.4 } }` and requires the usual bearer token. The response returns a saved quote id, fee, asset code, expiry, and observed distance, traffic and precipitation. It estimates a fee before creating a delivery; it does not automatically charge the customer or change an existing delivery.

Configure `GOOGLE_MAPS_API_KEY` (Directions API with traffic estimates), `OPENWEATHER_API_KEY` (current weather), and `MONGODB_URI` in the local `.env`. Do not commit credentials. The service fails with 503 when keys or an active pricing rule are missing, and with 502 when live provider data cannot be obtained. It deliberately does not use approximate routes or sample weather as a pricing fallback.

An operator must provision one active `PricingRule` document in MongoDB before enabling the endpoint. Fields: `name`, `active: true`, `assetCode`, `baseFee`, `distanceRate` (per km), `trafficMinuteRate` (per minute of traffic delay), `rainMillimeterRate` (per mm of current hourly rain or snow), `minimumFee`, and `validityMinutes`. All monetary rates use the configured asset's units. MongoDB enforces only one active rule. Configure rates and asset code for the deployed environment, rather than putting pricing values in application source.

Formula: `max(minimumFee, baseFee + distanceKm × distanceRate + max(0, trafficMinutes − normalMinutes) × trafficMinuteRate + hourlyPrecipitationMm × rainMillimeterRate)`, rounded to two decimal places. The persisted quote expires at the configured `validityMinutes`; MongoDB's TTL index removes it eventually. Quotes are advisory: creating a delivery or collecting payment must independently verify price and expiry before using one.

Soroban RPC is not involved in a read-only fee estimate. On-chain payment and escrow accounting require a separate confirmed contract ABI and asset conversion policy.
