import { QueryOptions, PaginationMeta } from '../types/query';
import { buildPaginationMeta } from '../middlewares/queryMiddleware';
import {
  AdminDriverRepository,
  AdminDriverRecord,
  adminDriverRepository,
} from '../repositories/AdminDriverRepository';

export interface AdminDriverDto {
  id: string;
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
  accountStatus: string;
  accountActive: boolean;
  tier: string;
  reputationPoints: number;
  rating: number;
  totalDeliveries: number;
  completedDeliveries: number;
  vehicleDetails: AdminDriverRecord['vehicleDetails'] | null;
  vehicleCapacityKg: number | null;
  isSuspended: boolean;
  suspendedUntil: Date | null;
  availabilityStatus: string;
  isAvailable: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface AdminDriverSearchResponse {
  drivers: AdminDriverDto[];
  pagination: PaginationMeta;
}

/** Admin-facing driver search orchestration and DTO shaping. */
export class AdminDriverSearchService {
  constructor(private readonly repository: AdminDriverRepository = adminDriverRepository) {}

  async search(options: QueryOptions, search?: string): Promise<AdminDriverSearchResponse> {
    const result = await this.repository.search(options, search);
    return {
      drivers: result.items.map((record) => this.toDto(record)),
      pagination: buildPaginationMeta(result.total, options.page, options.limit),
    };
  }

  private toDto(record: AdminDriverRecord): AdminDriverDto {
    return {
      id: String(record._id),
      userId: String(record.userId),
      firstName: record.firstName,
      lastName: record.lastName,
      email: record.email,
      accountStatus: record.accountStatus,
      accountActive: record.accountActive,
      tier: record.tier,
      reputationPoints: record.reputationPoints,
      rating: record.rating,
      totalDeliveries: record.totalDeliveries,
      completedDeliveries: record.completedDeliveries,
      vehicleDetails: record.vehicleDetails ?? null,
      vehicleCapacityKg: record.vehicleDetails?.capacityKg ?? null,
      isSuspended: record.isSuspended,
      suspendedUntil: record.suspendedUntil ?? null,
      availabilityStatus: record.availabilityStatus,
      isAvailable: record.isAvailable,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }
}

export const adminDriverSearchService = new AdminDriverSearchService();
