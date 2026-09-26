import { xdr, scValToNative } from '@stellar/stellar-sdk';
import { Delivery, DeliveryStatus } from '../models/Delivery';
import logger from '../config/logger';

/**
 * Apply a `delivery_created` indexer event: stamp the on-chain contract id
 * onto the local delivery record.
 */
async function updateDeliveryOnChainCreation(
  deliveryId: string,
  contractId: string,
): Promise<unknown> {
  const updated = await Delivery.findOneAndUpdate(
    { deliveryId },
    { contractId },
    { new: true },
  ).lean();

  if (!updated) {
    logger.warn(
      `[deliveryHandlers] delivery_created: delivery ${deliveryId} not found locally — skipping`,
    );
    return null;
  }

  logger.info(`[deliveryHandlers] delivery ${deliveryId} linked to contract ${contractId}`);
  return updated;
}

/**
 * Apply a `delivery_status_updated` indexer event: mirror the on-chain
 * status transition onto the local delivery record.
 */
async function updateDeliveryStatus(deliveryId: string, status: string): Promise<unknown> {
  const isKnownStatus = Object.values(DeliveryStatus).includes(status as DeliveryStatus);
  if (!isKnownStatus) {
    logger.warn(
      `[deliveryHandlers] delivery_status_updated: unknown status '${status}' for delivery ${deliveryId} — skipping`,
    );
    return null;
  }

  const updated = await Delivery.findOneAndUpdate(
    { deliveryId },
    { status: status as DeliveryStatus },
    { new: true, runValidators: true },
  ).lean();

  if (!updated) {
    logger.warn(
      `[deliveryHandlers] delivery_status_updated: delivery ${deliveryId} not found locally — skipping`,
    );
    return null;
  }

  logger.info(`[deliveryHandlers] delivery ${deliveryId} status updated to ${status}`);
  return updated;
}

export class DeliveryHandlers {
  public async processDeliveryCreatedEvent(xdrPayload: string) {
    try {
      const nativeData: any = scValToNative(xdr.ScVal.fromXDR(xdrPayload, 'base64'));
      const deliveryId = nativeData?.delivery_id;
      const contractId = nativeData?.contract_id;
      if (!deliveryId || !contractId) throw new Error('Missing delivery_id or contract_id');
      return await updateDeliveryOnChainCreation(deliveryId, contractId);
    } catch (error: any) {
      logger.error(`Error processing delivery_created event: ${error.message}`);
      throw error;
    }
  }

  public async processDeliveryStatusUpdatedEvent(xdrPayload: string): Promise<unknown> {
    try {
      const nativeData: any = scValToNative(xdr.ScVal.fromXDR(xdrPayload, 'base64'));
      const deliveryId = nativeData?.delivery_id;
      const status = nativeData?.status;
      if (!deliveryId || !status) throw new Error('Missing delivery_id or status');
      const normalizedStatus = typeof status === 'string' ? status : String(status);
      return await updateDeliveryStatus(deliveryId, normalizedStatus);
    } catch (error: any) {
      logger.error(`Error processing delivery_status_updated event: ${error.message}`);
      throw error;
    }
  }
}
export const deliveryHandlers = new DeliveryHandlers();
