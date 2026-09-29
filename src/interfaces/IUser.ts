import { Document } from 'mongoose';

export enum UserRole {
  USER = 'user',
  DRIVER = 'driver',
  ADMIN = 'admin',
  ENTERPRISE = 'enterprise',
}

export enum UserStatus {
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
  BANNED = 'banned',
}

export interface IUser extends Document {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  isActive: boolean;
  status: UserStatus;
  walletAddress?: string;
  suspendedReason?: string;
  suspendedAt?: Date;
  profilePicture?: string;
  profilePictureKey?: string;
  isDeleted?: boolean;
  deletedAt?: Date | null;
  deletedBy?: string;
  createdAt: Date;
  updatedAt: Date;
  comparePassword(candidatePassword: string): Promise<boolean>;
  softDelete(userId?: string): Promise<this>;
  restore(): Promise<this>;
}

export interface ILoginPayload {
  email: string;
  password: string;
}

export interface IAuthResponse {
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    role: UserRole;
  };
  token: string;
}
