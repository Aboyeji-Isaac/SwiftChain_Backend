import { Document, Types } from 'mongoose';

export enum ReputationTier {
  BRONZE = 'bronze',
  SILVER = 'silver',
  GOLD = 'gold',
  PLATINUM = 'platinum',
}

export interface IVehicleDetails {
  make: string;
  model: string;
  year?: number;
  plateNumber: string;
  capacityKg?: number;
}

export interface IDriverProfile extends Document {
  userId: Types.ObjectId;
  reputationPoints: number;
  tier: ReputationTier;
  totalDeliveries: number;
  completedDeliveries: number;
  vehicleDetails?: IVehicleDetails;
  isDeleted?: boolean;
  deletedAt?: Date | null;
  deletedBy?: string;
  createdAt: Date;
  updatedAt: Date;
  softDelete(userId?: string): Promise<this>;
  restore(): Promise<this>;
}

export const TIER_THRESHOLDS: Record<ReputationTier, number> = {
  [ReputationTier.BRONZE]: 0,
  [ReputationTier.SILVER]: 100,
  [ReputationTier.GOLD]: 500,
  [ReputationTier.PLATINUM]: 1000,
};

export function computeTier(points: number): ReputationTier {
  if (points >= TIER_THRESHOLDS[ReputationTier.PLATINUM]) return ReputationTier.PLATINUM;
  if (points >= TIER_THRESHOLDS[ReputationTier.GOLD]) return ReputationTier.GOLD;
  if (points >= TIER_THRESHOLDS[ReputationTier.SILVER]) return ReputationTier.SILVER;
  return ReputationTier.BRONZE;
}
