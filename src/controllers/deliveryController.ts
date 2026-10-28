/**
 * @deprecated Deprecated compatibility shim — canonical implementation lives in
 * `delivery.controller.ts` (single canonical delivery controller).
 *
 * Re-exports the canonical `DeliveryController` singleton so existing imports
 * of `./deliveryController` keep working during the migration. New code must
 * import from `./delivery.controller` instead.
 */
export { DeliveryController, deliveryController } from './delivery.controller';
