import { StatusCodes } from 'http-status-codes';
import mongoose from 'mongoose';
import Fleet from '../models/Fleet';
import FleetInvitation from '../models/FleetInvitation';
import Delivery from '../models/Delivery';
import User from '../models/User';
import { UserRole } from '../interfaces/IUser';
import { IFleet, IFleetInvitation, FleetInvitationStatus } from '../interfaces/IFleet';
import AppError from '../utils/AppError';

// ─── DTOs ──────────────────────────────────────────────────────────────────────

export interface CreateFleetInput {
  ownerId: string;
  name: string;
}

export interface InviteDriverInput {
  fleetId: string;
  driverId: string;
  invitedBy: string;
}

export interface RespondToInvitationInput {
  invitationId: string;
  driverId: string;
  accept: boolean;
}

export interface FleetMetrics {
  fleetId: string;
  driverCount: number;
  totalDeliveries: number;
  completedDeliveries: number;
  /** XLM only; other asset pools are excluded from this legacy metric. */
  totalEscrowValue: number;
  totalEscrowValueAsset: 'XLM';
}

// ─── Service ───────────────────────────────────────────────────────────────────

/**
 * Creates a new fleet owned by an enterprise user.
 *
 * Business rules enforced here:
 *  - Owner must exist and hold the ENTERPRISE role (defense-in-depth: the
 *    route is also gated by requireRole, but the service does not trust the
 *    caller blindly since it can be invoked from other code paths later).
 *  - Fleet name is required and de-duplicated per owner (an enterprise user
 *    cannot create two fleets with the same name).
 */
export const createFleet = async (input: CreateFleetInput): Promise<IFleet> => {
  const { ownerId, name } = input;

  if (!mongoose.Types.ObjectId.isValid(ownerId)) {
    throw new AppError('Invalid owner ID format.', StatusCodes.BAD_REQUEST);
  }

  const owner = await User.findById(ownerId);
  if (!owner) {
    throw new AppError('Owner not found.', StatusCodes.NOT_FOUND);
  }

  if (owner.role !== UserRole.ENTERPRISE) {
    throw new AppError('Only enterprise users can create fleets.', StatusCodes.FORBIDDEN);
  }

  const existing = await Fleet.findOne({ ownerId, name: name.trim() });
  if (existing) {
    throw new AppError('You already have a fleet with this name.', StatusCodes.CONFLICT);
  }

  return Fleet.create({ ownerId, name: name.trim() });
};

/**
 * Invites a driver to join a fleet.
 *
 * Business rules enforced here:
 *  - Fleet must exist; caller must be the fleet's owner.
 *  - Target user must exist and hold the DRIVER role.
 *  - Driver must not already be a member of the fleet.
 *  - Driver must not already have a pending invitation to this fleet
 *    (the schema's partial unique index also guards this at the DB level;
 *    this check produces a friendlier 409 instead of a raw duplicate-key error).
 */
export const inviteDriver = async (input: InviteDriverInput): Promise<IFleetInvitation> => {
  const { fleetId, driverId, invitedBy } = input;

  if (!mongoose.Types.ObjectId.isValid(fleetId)) {
    throw new AppError('Invalid fleet ID format.', StatusCodes.BAD_REQUEST);
  }
  if (!mongoose.Types.ObjectId.isValid(driverId)) {
    throw new AppError('Invalid driver ID format.', StatusCodes.BAD_REQUEST);
  }

  const fleet = await Fleet.findById(fleetId);
  if (!fleet) {
    throw new AppError('Fleet not found.', StatusCodes.NOT_FOUND);
  }

  if (fleet.ownerId.toString() !== invitedBy) {
    throw new AppError('Only the fleet owner can invite drivers.', StatusCodes.FORBIDDEN);
  }

  const driver = await User.findById(driverId);
  if (!driver) {
    throw new AppError('Driver not found.', StatusCodes.NOT_FOUND);
  }
  if (driver.role !== UserRole.DRIVER) {
    throw new AppError(
      'The invited user is not registered as a driver.',
      StatusCodes.UNPROCESSABLE_ENTITY,
    );
  }

  const alreadyMember = fleet.drivers.some((id) => id.toString() === driverId);
  if (alreadyMember) {
    throw new AppError('This driver is already a member of the fleet.', StatusCodes.CONFLICT);
  }

  const existingPending = await FleetInvitation.findOne({
    fleetId,
    driverId,
    status: FleetInvitationStatus.PENDING,
  });
  if (existingPending) {
    throw new AppError(
      'This driver already has a pending invitation to this fleet.',
      StatusCodes.CONFLICT,
    );
  }

  return FleetInvitation.create({ fleetId, driverId, invitedBy });
};

/**
 * A driver accepts or declines a pending fleet invitation.
 *
 * On accept: the driver is added to the fleet's `drivers` array and the
 * invitation is marked accepted. On decline: only the invitation status
 * changes.
 */
export const respondToInvitation = async (
  input: RespondToInvitationInput,
): Promise<IFleetInvitation> => {
  const { invitationId, driverId, accept } = input;

  if (!mongoose.Types.ObjectId.isValid(invitationId)) {
    throw new AppError('Invalid invitation ID format.', StatusCodes.BAD_REQUEST);
  }

  const invitation = await FleetInvitation.findById(invitationId);
  if (!invitation) {
    throw new AppError('Invitation not found.', StatusCodes.NOT_FOUND);
  }

  if (invitation.driverId.toString() !== driverId) {
    throw new AppError(
      'You do not have permission to respond to this invitation.',
      StatusCodes.FORBIDDEN,
    );
  }

  if (invitation.status !== FleetInvitationStatus.PENDING) {
    throw new AppError(
      `This invitation has already been ${invitation.status}.`,
      StatusCodes.CONFLICT,
    );
  }

  invitation.status = accept ? FleetInvitationStatus.ACCEPTED : FleetInvitationStatus.DECLINED;
  invitation.respondedAt = new Date();
  await invitation.save();

  if (accept) {
    await Fleet.findByIdAndUpdate(invitation.fleetId, {
      $addToSet: { drivers: invitation.driverId },
    });
  }

  return invitation;
};

/**
 * Aggregates delivery and revenue statistics for a fleet.
 *
 * Delivery.driverId is stored as a plain string (not a Mongoose ref), so
 * fleet drivers' ObjectIds are compared as strings when matching deliveries.
 */
export const getFleetMetrics = async (
  fleetId: string,
  requesterId: string,
): Promise<FleetMetrics> => {
  if (!mongoose.Types.ObjectId.isValid(fleetId)) {
    throw new AppError('Invalid fleet ID format.', StatusCodes.BAD_REQUEST);
  }

  const fleet = await Fleet.findById(fleetId);
  if (!fleet) {
    throw new AppError('Fleet not found.', StatusCodes.NOT_FOUND);
  }

  if (fleet.ownerId.toString() !== requesterId) {
    throw new AppError('Only the fleet owner can view fleet metrics.', StatusCodes.FORBIDDEN);
  }

  const driverIds = fleet.drivers.map((id) => id.toString());

  if (driverIds.length === 0) {
    return {
      fleetId,
      driverCount: 0,
      totalDeliveries: 0,
      completedDeliveries: 0,
      totalEscrowValue: 0,
      totalEscrowValueAsset: 'XLM',
    };
  }

  const [totals] = await Delivery.aggregate<{
    totalDeliveries: number;
    completedDeliveries: number;
    totalEscrowValue: number;
  }>([
    { $match: { driverId: { $in: driverIds } } },
    {
      $group: {
        _id: null,
        totalDeliveries: { $sum: 1 },
        completedDeliveries: {
          $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] },
        },
        totalEscrowValue: {
          $sum: {
            $cond: [
              { $eq: [{ $ifNull: ['$escrowAsset.code', 'XLM'] }, 'XLM'] },
              { $ifNull: ['$escrowAmount', 0] },
              0,
            ],
          },
        },
      },
    },
  ]);

  return {
    fleetId,
    driverCount: driverIds.length,
    totalDeliveries: totals?.totalDeliveries ?? 0,
    completedDeliveries: totals?.completedDeliveries ?? 0,
    totalEscrowValue: totals?.totalEscrowValue ?? 0,
    totalEscrowValueAsset: 'XLM',
  };
};
