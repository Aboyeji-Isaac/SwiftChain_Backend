import { FilterQuery } from 'mongoose';
import Delivery, { DeliveryStatus, IDelivery } from '../models/Delivery';
import { BaseRepository } from './BaseRepository';
import { Page, ReadOptions, WriteOptions } from './types';

/** Filter criteria accepted by {@link DeliveryRepository.listPaginated}. */
export interface DeliveryQueryFilter {
  status?: DeliveryStatus;
  driverId?: string;
  /** Case-insensitive match against tracking number, customer name or phone. */
  search?: string;
}

/**
 * Persistence gateway for the `Delivery` collection.
 *
 * Archived (soft-deleted) documents are excluded by default; the `*Archived`
 * methods opt back in via the `includeDeleted` query option that the model's
 * soft-delete behaviour reads.
 */
export class DeliveryRepository extends BaseRepository<IDelivery> {
  constructor() {
    super(Delivery);
  }

  /** Look up a delivery by its externally-visible tracking number. */
  async findByTrackingNumber(
    trackingNumber: string,
    options?: ReadOptions<IDelivery>,
  ): Promise<IDelivery | null> {
    return this.findOne({ trackingNumber }, options);
  }

  /**
   * Check whether a tracking number is already taken.
   *
   * Includes archived deliveries — a tracking number stays reserved after a
   * delivery is archived so restoring one can never collide with a newer record.
   */
  async trackingNumberExists(trackingNumber: string): Promise<boolean> {
    return this.exists(
      { trackingNumber },
      { queryOptions: { includeDeleted: true } as Record<string, unknown> },
    );
  }

  /**
   * Return only the tracking numbers already present from the given candidates.
   *
   * Used by bulk import to detect duplicates in one query instead of issuing
   * one existence check per row.
   */
  async findExistingTrackingNumbers(trackingNumbers: string[]): Promise<Set<string>> {
    if (trackingNumbers.length === 0) return new Set();

    const found = await this.find(
      { trackingNumber: { $in: trackingNumbers } },
      {
        projection: { trackingNumber: 1 },
        lean: true,
        queryOptions: { includeDeleted: true } as Record<string, unknown>,
      },
    );

    return new Set(
      found
        .map((doc) => (doc as unknown as { trackingNumber?: string }).trackingNumber)
        .filter((value): value is string => typeof value === 'string'),
    );
  }

  /** Translate domain filters into a Mongo query and return one page. */
  async listPaginated(
    filter: DeliveryQueryFilter,
    page: number,
    limit: number,
  ): Promise<Page<IDelivery>> {
    return this.paginate(this.buildFilter(filter), page, limit, {
      sort: { createdAt: -1 },
    });
  }

  /** List archived deliveries, most recently archived first. */
  async listArchived(page: number, limit: number): Promise<Page<IDelivery>> {
    return this.paginate({ isDeleted: true }, page, limit, {
      sort: { deletedAt: -1 },
      queryOptions: { includeDeleted: true } as Record<string, unknown>,
    });
  }

  /**
   * Load a delivery even if it has been archived.
   *
   * Archive/restore flows need to see soft-deleted documents that the default
   * read path hides.
   */
  async findByIdIncludingArchived(id: string): Promise<IDelivery | null> {
    return this.findById(id, {
      queryOptions: { includeDeleted: true } as Record<string, unknown>,
    });
  }

  /** Deliveries currently assigned to a driver, newest first. */
  async findByDriver(driverId: string, options?: ReadOptions<IDelivery>): Promise<IDelivery[]> {
    return this.find({ driverId }, { sort: { createdAt: -1 }, ...options });
  }

  /**
   * Apply a status change reported by an on-chain `delivery_status_updated` event.
   *
   * The event announces a new authoritative status for a delivery identified by
   * its tracking number. This updates the database directly, bypassing the normal
   * state-machine guards in {@link transitionStatus} because the chain is the
   * source of truth.
   */
  async updateStatusByTrackingNumber(
    trackingNumber: string,
    status: DeliveryStatus,
    options?: WriteOptions,
  ): Promise<IDelivery | null> {
    if (!trackingNumber.trim()) return null;
    return this.updateOne({ trackingNumber }, { $set: { status } }, options);
  }

  /**
   * Atomically move a delivery from one status to another.
   *
   * The expected current status is part of the filter, so two concurrent
   * transition requests cannot both succeed — the loser matches no document
   * and receives `null`. This is what makes status transitions safe without a
   * distributed lock.
   *
   * @returns The updated delivery, or `null` if it was not in `from`.
   */
  async transitionStatus(
    id: string,
    from: DeliveryStatus | DeliveryStatus[],
    to: DeliveryStatus,
    options?: WriteOptions,
  ): Promise<IDelivery | null> {
    if (!this.isValidId(id)) return null;

    const expected = Array.isArray(from) ? from : [from];
    return this.updateOne(
      { _id: id, status: { $in: expected } } as FilterQuery<IDelivery>,
      { $set: { status: to } },
      options,
    );
  }

  /** Compose the Mongo filter for {@link listPaginated}. */
  private buildFilter(filter: DeliveryQueryFilter): FilterQuery<IDelivery> {
    const query: FilterQuery<IDelivery> = {};

    if (filter.status) query.status = filter.status;
    if (filter.driverId) query.driverId = filter.driverId;

    if (filter.search) {
      // Escape user input so regex metacharacters are matched literally
      // rather than interpreted as a pattern.
      const escaped = filter.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.$or = [
        { trackingNumber: { $regex: escaped, $options: 'i' } },
        { 'customer.name': { $regex: escaped, $options: 'i' } },
        { 'customer.phone': { $regex: escaped, $options: 'i' } },
      ];
    }

    return query;
  }
}

export const deliveryRepository = new DeliveryRepository();
