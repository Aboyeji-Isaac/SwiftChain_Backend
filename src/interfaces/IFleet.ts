import { Document, Types } from 'mongoose';

export interface IMember {
  userId: Types.ObjectId;
  role: 'admin' | 'driver' | 'viewer';
  joinedAt: Date;
}

export interface IBusinessMetadata {
  companyName: string;
  industry?: string;
  registrationNumber?: string;
  vatNumber?: string;
  address?: {
    street: string;
    city: string;
    country: string;
    postalCode: string;
  };
  contactEmail: string;
  contactPhone?: string;
  website?: string;
}

export interface IFleet extends Document {
  name: string;
  treasuryAddress: string;
  ownerId: Types.ObjectId;
  members: IMember[];
  businessMetadata: IBusinessMetadata;
  isActive: boolean;
  // For backward compatibility
  drivers: Types.ObjectId[];
  createdAt: Date;
  updatedAt: Date;
}

export enum FleetInvitationStatus {
  PENDING = 'pending',
  ACCEPTED = 'accepted',
  DECLINED = 'declined',
}

export interface IFleetInvitation extends Document {
  fleetId: Types.ObjectId;
  driverId: Types.ObjectId;
  invitedBy: Types.ObjectId;
  status: FleetInvitationStatus;
  respondedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}
