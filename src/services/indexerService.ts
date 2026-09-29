import EventLog from '../models/EventLog';
import Delivery from '../models/Delivery';
import { sorobanRpcClient } from '../config/stellar';
import logger from '../config/logger';
import { emitDeliveryStatusUpdated } from '../sockets';
export interface IndexerStatusData {
  eventType: string;
  contractId: string;
  lastProcessedLedger: number;
  currentLedger: number;
  lag: number;
  updatedAt: Date;
}

export interface DeliveryStatusUpdatedEvent {
  contractId: string;
  deliveryId: string;
  newStatus: string;
}

export class IndexerService {
  public async getIndexerStatus(): Promise<IndexerStatusData[]> {
    try {
      const currentLedgerResponse = await sorobanRpcClient.getLatestLedger();
      const currentLedger = currentLedgerResponse.sequence;
      const logs = await EventLog.find({}).lean();
      return logs.map((log) => {
        const lastProcessedLedger = Number(log.ledgerSequence ?? 0);
        return {
          eventType: log.eventType,
          contractId: log.contractId ?? '',
          lastProcessedLedger,
          currentLedger,
          lag: Math.max(0, currentLedger - lastProcessedLedger),
          updatedAt: log.updatedAt,
        };
      });
    } catch (error) {
      logger.error(
        `[IndexerService] Error fetching indexer status: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw error;
    }
  }

  public async processDeliveryStatusUpdated(event: DeliveryStatusUpdatedEvent): Promise<void> {
    try {
      const { contractId, deliveryId, newStatus } = event;
      const updatedDelivery = await Delivery.findOneAndUpdate(
        { _id: deliveryId, contractId },
        { status: newStatus },
        { new: true, runValidators: true },
      ).lean();
      if (!updatedDelivery) {
        logger.warn(
          `[IndexerService] Delivery not found for id ${deliveryId} on contract ${contractId}`,
        );
        return;
      }
      // Push the transition to any connected realtime clients (no-op when the
      // socket namespace has not been initialised, e.g. in tests).
      emitDeliveryStatusUpdated(deliveryId, {
        contractId,
        deliveryId,
        status: newStatus,
      });
      logger.info(
        `[IndexerService] Delivery ${deliveryId} status updated to ${newStatus} on contract ${contractId}`,
      );
    } catch (error) {
      logger.error(
        `[IndexerService] Error processing delivery_status_updated event: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw error;
    }
  }
}

export const indexerService = new IndexerService();
