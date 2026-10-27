import { FilterQuery, PipelineStage } from 'mongoose';
import DriverProfile from '../models/DriverProfile';
import { DriverLocation } from '../models/DriverLocation';
import User from '../models/User';
import { ReputationTier } from '../interfaces/IDriverProfile';
import { UserRole } from '../interfaces/IUser';
import { DriverAvailabilityStatus } from '../models/DriverLocation';
import { QueryOptions } from '../types/query';
import ApiError from '../utils/ApiError';

export interface AdminDriverRecord {
  _id: unknown;
  userId: unknown;
  firstName: string;
  lastName: string;
  email: string;
  accountStatus: string;
  accountActive: boolean;
  tier: ReputationTier;
  reputationPoints: number;
  rating: number;
  totalDeliveries: number;
  completedDeliveries: number;
  vehicleDetails?: {
    make?: string;
    model?: string;
    year?: number;
    plateNumber?: string;
    capacityKg?: number;
  };
  isSuspended: boolean;
  suspendedUntil?: Date | null;
  availabilityStatus: DriverAvailabilityStatus | 'offline';
  isAvailable: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface AdminDriverSearchResult {
  items: AdminDriverRecord[];
  total: number;
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');

const numericFilter = (
  filter: Record<string, unknown>,
  key: string,
  integer = false,
): number | undefined => {
  const value = filter[key];
  if (value === undefined) return undefined;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    (integer && !Number.isInteger(value))
  ) {
    throw ApiError.badRequest(
      key + (integer ? ' must be a non-negative integer' : ' must be a non-negative number'),
    );
  }
  return value;
};

/**
 * Repository for the admin driver search. All MongoDB reads and aggregation
 * stages live here so controllers/services do not access models directly.
 */
export class AdminDriverRepository {
  async search(
    options: QueryOptions,
    search?: string,
  ): Promise<AdminDriverSearchResult> {
    const rawFilter = (options.filter ?? {}) as Record<string, unknown>;
    const profileMatch: FilterQuery<Record<string, unknown>> = { isDeleted: { $ne: true } };

    if (rawFilter.tier !== undefined) {
      const tier = rawFilter.tier;
      if (typeof tier !== 'string' || !Object.values(ReputationTier).includes(tier as ReputationTier)) {
        throw ApiError.badRequest('tier must be one of: ' + Object.values(ReputationTier).join(', '));
      }
      profileMatch.tier = tier;
    }

    const minVehicleCapacity = numericFilter(rawFilter, 'minVehicleCapacity');
    if (minVehicleCapacity !== undefined) {
      profileMatch['vehicleDetails.capacityKg'] = { $gte: minVehicleCapacity };
    }

    const minReputation = numericFilter(rawFilter, 'minReputation', true);
    const maxReputation = numericFilter(rawFilter, 'maxReputation', true);
    if (minReputation !== undefined || maxReputation !== undefined) {
      const reputationRange: Record<string, number> = {};
      if (minReputation !== undefined) reputationRange.$gte = minReputation;
      if (maxReputation !== undefined) reputationRange.$lte = maxReputation;
      if (minReputation !== undefined && maxReputation !== undefined && minReputation > maxReputation) {
        throw ApiError.badRequest('minReputation cannot exceed maxReputation');
      }
      profileMatch.reputationPoints = reputationRange;
    }

    const minCompletedDeliveries = numericFilter(rawFilter, 'minCompletedDeliveries', true);
    const maxCompletedDeliveries = numericFilter(rawFilter, 'maxCompletedDeliveries', true);
    if (minCompletedDeliveries !== undefined || maxCompletedDeliveries !== undefined) {
      const deliveryRange: Record<string, number> = {};
      if (minCompletedDeliveries !== undefined) deliveryRange.$gte = minCompletedDeliveries;
      if (maxCompletedDeliveries !== undefined) deliveryRange.$lte = maxCompletedDeliveries;
      if (
        minCompletedDeliveries !== undefined &&
        maxCompletedDeliveries !== undefined &&
        minCompletedDeliveries > maxCompletedDeliveries
      ) {
        throw ApiError.badRequest('minCompletedDeliveries cannot exceed maxCompletedDeliveries');
      }
      profileMatch.completedDeliveries = deliveryRange;
    }

    const minTotalDeliveries = numericFilter(rawFilter, 'minTotalDeliveries', true);
    const maxTotalDeliveries = numericFilter(rawFilter, 'maxTotalDeliveries', true);
    if (minTotalDeliveries !== undefined || maxTotalDeliveries !== undefined) {
      const totalDeliveryRange: Record<string, number> = {};
      if (minTotalDeliveries !== undefined) totalDeliveryRange.$gte = minTotalDeliveries;
      if (maxTotalDeliveries !== undefined) totalDeliveryRange.$lte = maxTotalDeliveries;
      if (
        minTotalDeliveries !== undefined &&
        maxTotalDeliveries !== undefined &&
        minTotalDeliveries > maxTotalDeliveries
      ) {
        throw ApiError.badRequest('minTotalDeliveries cannot exceed maxTotalDeliveries');
      }
      profileMatch.totalDeliveries = totalDeliveryRange;
    }

    const pipeline: PipelineStage[] = [
      { $match: profileMatch },
      {
        $lookup: {
          from: User.collection.name,
          localField: 'userId',
          foreignField: '_id',
          as: 'user',
        },
      },
      { $unwind: '$user' },
      {
        $match: {
          'user.role': UserRole.DRIVER,
          'user.isDeleted': { $ne: true },
        },
      },
      {
        $lookup: {
          from: DriverLocation.collection.name,
          localField: 'userId',
          foreignField: 'driverId',
          as: 'driverLocation',
        },
      },
      {
        $unwind: {
          path: '$driverLocation',
          preserveNullAndEmptyArrays: true,
        },
      },
    ];

    if (search !== undefined && search.trim() !== '') {
      const term = search.trim();
      if (term.length > 100) {
        throw ApiError.badRequest('search must be 100 characters or fewer');
      }
      const pattern = new RegExp(escapeRegExp(term), 'i');
      pipeline.push(
        {
          $addFields: {
            _searchFullName: {
              $concat: [
                { $ifNull: ['$user.firstName', ''] },
                ' ',
                { $ifNull: ['$user.lastName', ''] },
              ],
            },
          },
        },
        {
          $match: {
            $or: [
              { 'user.firstName': pattern },
              { 'user.lastName': pattern },
              { 'user.email': pattern },
              { _searchFullName: pattern },
            ],
          },
        },
      );
    }

    const availability = rawFilter.availability;
    if (availability !== undefined) {
      if (typeof availability !== 'string') {
        throw ApiError.badRequest('availability must be a string');
      }
      const validStatuses: DriverAvailabilityStatus[] = ['online', 'offline', 'on_delivery'];
      if (availability === 'available') {
        pipeline.push({ $match: { 'driverLocation.isAvailable': true } });
      } else if (availability === 'unavailable') {
        pipeline.push({
          $match: {
            $or: [
              { 'driverLocation.isAvailable': false },
              { driverLocation: { $exists: false } },
              { driverLocation: null },
            ],
          },
        });
      } else if (availability === 'offline') {
        pipeline.push({
          $match: {
            $or: [
              { 'driverLocation.status': 'offline' },
              { driverLocation: { $exists: false } },
              { driverLocation: null },
            ],
          },
        });
      } else if (validStatuses.includes(availability as DriverAvailabilityStatus)) {
        pipeline.push({ $match: { 'driverLocation.status': availability } });
      } else {
        throw ApiError.badRequest(
          'availability must be one of: available, unavailable, ' + validStatuses.join(', '),
        );
      }
    }

    const allowedSortFields = new Set([
      'createdAt',
      'updatedAt',
      'reputationPoints',
      'rating',
      'totalDeliveries',
      'completedDeliveries',
      'tier',
    ]);
    const sort: Record<string, 1 | -1> = {};
    for (const [field, direction] of Object.entries(options.sort ?? {})) {
      if (allowedSortFields.has(field)) {
        sort[field] = direction === -1 ? -1 : 1;
      }
    }
    if (Object.keys(sort).length === 0) sort.createdAt = -1;

    pipeline.push({
      $facet: {
        items: [
          { $sort: sort },
          { $skip: options.skip },
          { $limit: options.limit },
          {
            $project: {
              _id: 1,
              userId: 1,
              firstName: '$user.firstName',
              lastName: '$user.lastName',
              email: '$user.email',
              accountStatus: '$user.status',
              accountActive: '$user.isActive',
              tier: 1,
              reputationPoints: 1,
              rating: 1,
              totalDeliveries: 1,
              completedDeliveries: 1,
              vehicleDetails: 1,
              isSuspended: 1,
              suspendedUntil: 1,
              createdAt: 1,
              updatedAt: 1,
              availabilityStatus: { $ifNull: ['$driverLocation.status', 'offline'] },
              isAvailable: { $ifNull: ['$driverLocation.isAvailable', false] },
            },
          },
        ],
        total: [{ $count: 'value' }],
      },
    });

    const [result] = await DriverProfile.aggregate<{
      items: AdminDriverRecord[];
      total: Array<{ value: number }>;
    }>(pipeline).exec();

    return {
      items: result?.items ?? [],
      total: result?.total[0]?.value ?? 0,
    };
  }
}

export const adminDriverRepository = new AdminDriverRepository();
