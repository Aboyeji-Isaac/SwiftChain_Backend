import EventLog, { IEventLog } from '../models/EventLog';
import logger from '../config/logger';

export class EventLogService {
  /**
   * Create a new event log entry
   */
  async createEventLog(eventData: Partial<IEventLog>): Promise<IEventLog> {
    try {
      // Check if event already exists
      if (eventData.transactionHash && eventData.eventType) {
        const exists = await EventLog.eventExists(eventData.transactionHash, eventData.eventType);
        if (exists) {
          throw new Error('Event already exists');
        }
      }

      const eventLog = new EventLog(eventData);
      await eventLog.save();
      logger.info(`Event log created: ${eventLog.id} for transaction ${eventLog.transactionHash}`);
      return eventLog;
    } catch (error) {
      logger.error('Error creating event log:', error);
      throw error;
    }
  }

  /**
   * Mark an event as processed
   */
  async markAsProcessed(transactionHash: string, eventType: string): Promise<IEventLog | null> {
    try {
      const updated = await EventLog.markAsProcessed(transactionHash, eventType);
      if (updated) {
        logger.info(`Event marked as processed: ${updated.id}`);
      }
      return updated;
    } catch (error) {
      logger.error('Error marking event as processed:', error);
      throw error;
    }
  }

  /**
   * Get the last processed ledger sequence
   */
  async getLastProcessedLedger(eventType?: string): Promise<number> {
    try {
      return await EventLog.getLastProcessedLedger(eventType);
    } catch (error) {
      logger.error('Error getting last processed ledger:', error);
      return 0;
    }
  }

  /**
   * Get all unprocessed events
   */
  async getUnprocessedEvents(): Promise<IEventLog[]> {
    try {
      return await EventLog.find({ status: 'pending' }).sort({ createdAt: 1 }).limit(100);
    } catch (error) {
      logger.error('Error fetching unprocessed events:', error);
      return [];
    }
  }

  /**
   * Get events by ledger sequence range
   */
  async getEventsByLedgerRange(
    startLedger: number,
    endLedger: number,
    eventType?: string,
  ): Promise<IEventLog[]> {
    try {
      const query: any = {
        ledgerSequence: { $gte: startLedger, $lte: endLedger },
      };
      if (eventType) {
        query.eventType = eventType;
      }
      return await EventLog.find(query).sort({ ledgerSequence: 1 });
    } catch (error) {
      logger.error('Error fetching events by ledger range:', error);
      return [];
    }
  }

  /**
   * Get event by transaction hash
   */
  async getEventByTransactionHash(transactionHash: string): Promise<IEventLog | null> {
    try {
      return await EventLog.findOne({ transactionHash });
    } catch (error) {
      logger.error('Error fetching event by transaction hash:', error);
      return null;
    }
  }

  /**
   * Update event status with error
   */
  async markEventFailed(eventId: string, errorMessage: string): Promise<IEventLog | null> {
    try {
      const event = await EventLog.findByIdAndUpdate(
        eventId,
        { status: 'failed', errorMessage },
        { new: true },
      );
      if (event) {
        logger.warn(`Event ${eventId} marked as failed: ${errorMessage}`);
      }
      return event;
    } catch (error) {
      logger.error('Error marking event as failed:', error);
      return null;
    }
  }
}

export default new EventLogService();
