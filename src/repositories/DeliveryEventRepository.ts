import { Types } from 'mongoose';
import DeliveryEvent, {
  DeliveryMilestone,
  IDeliveryEvent,
  IMilestoneActor,
} from '../models/DeliveryEvent';
import { DeliveryStatus } from '../models/Delivery';
import { BaseRepository } from './BaseRepository';
import { Page, WriteOptions } from './types';

/** Everything needed to append a milestone; `seq` is assigned by the repository. */
export interface AppendDeliveryEventInput {
  delivery: Types.ObjectId | string;
  event: DeliveryMilestone;
  fromStatus: DeliveryStatus | null;
  toStatus: DeliveryStatus;
  payload?: Record<string, unknown>;
  actor: IMilestoneActor;
  occurredAt?: Date;
}

/** Attempts before giving up when concurrent writers keep colliding on `seq`. */
const MAX_SEQ_ATTEMPTS = 5;

const MONGO_DUPLICATE_KEY = 11000;

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === MONGO_DUPLICATE_KEY
  );
}

/**
 * Persistence gateway for the append-only `DeliveryEvent` log.
 *
 * Ordering is guaranteed by the database: `(delivery, seq)` is a unique index,
 * and `seq` is computed as the current maximum + 1. Two concurrent appends for
 * the same delivery cannot both win a seq; the loser retries with a fresh one.
 */
export class DeliveryEventRepository extends BaseRepository<IDeliveryEvent> {
  constructor() {
    super(DeliveryEvent);
  }

  /** Highest seq recorded for a delivery, or 0 when it has no events yet. */
  async getLastSeq(deliveryId: Types.ObjectId | string): Promise<number> {
    const last = await this.model
      .findOne({ delivery: deliveryId })
      .sort({ seq: -1 })
      .select('seq')
      .lean()
      .exec();
    return last?.seq ?? 0;
  }

  /**
   * Append the next milestone for a delivery, assigning a gapless `seq`.
   *
   * @throws The last duplicate-key error if every attempt collided.
   */
  async append(input: AppendDeliveryEventInput, options?: WriteOptions): Promise<IDeliveryEvent> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_SEQ_ATTEMPTS; attempt += 1) {
      const seq = (await this.getLastSeq(input.delivery)) + 1;
      try {
        return await this.create(
          {
            delivery: new Types.ObjectId(String(input.delivery)),
            event: input.event,
            fromStatus: input.fromStatus,
            toStatus: input.toStatus,
            payload: input.payload ?? {},
            actor: input.actor,
            occurredAt: input.occurredAt ?? new Date(),
            seq,
          },
          options,
        );
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
        lastError = error;
      }
    }

    throw lastError;
  }

  /** One page of a delivery's milestones, oldest first (by seq). */
  async listByDelivery(
    deliveryId: string,
    page: number,
    limit: number,
  ): Promise<Page<IDeliveryEvent>> {
    if (!this.isValidId(deliveryId)) {
      return { data: [], total: 0, page: 1, limit, totalPages: 0 };
    }
    return this.paginate({ delivery: deliveryId }, page, limit, { sort: { seq: 1 } });
  }
}

export const deliveryEventRepository = new DeliveryEventRepository();
