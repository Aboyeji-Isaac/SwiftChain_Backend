import { Request, Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import {
  inviteDriver as inviteDriverService,
  respondToInvitation as respondToInvitationService,
  getFleetMetrics as getFleetMetricsService,
} from '../services/fleetService';
import type { IUser } from '../interfaces/IUser';
import AppError from '../utils/AppError';
import mongoose from 'mongoose';
import Fleet from '../models/Fleet';
import User from '../models/User';
import { sendSuccess } from '../utils/responseWrapper';

// ─── Request body types ────────────────────────────────────────────────────────

interface CreateFleetBody {
  name?: unknown;
  treasuryAddress?: unknown;
  businessMetadata?: {
    companyName?: unknown;
    industry?: unknown;
    registrationNumber?: unknown;
    vatNumber?: unknown;
    address?: {
      street?: unknown;
      city?: unknown;
      country?: unknown;
      postalCode?: unknown;
    };
    contactEmail?: unknown;
    contactPhone?: unknown;
    website?: unknown;
  };
}

interface InviteDriverBody {
  driverId?: unknown;
}

interface RespondToInvitationBody {
  accept?: unknown;
}

// ─── Controller ────────────────────────────────────────────────────────────────

/**
 * POST /api/v1/fleets
 */
export const createFleet = async (
  req: Request<unknown, unknown, CreateFleetBody>,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const owner = (req as Request & { user?: IUser }).user;
    if (!owner) {
      throw new AppError('Authentication required.', StatusCodes.UNAUTHORIZED);
    }

    const { name, treasuryAddress, businessMetadata } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length < 2) {
      throw new AppError(
        'A fleet name of at least 2 characters is required.',
        StatusCodes.BAD_REQUEST,
      );
    }

    if (!treasuryAddress || typeof treasuryAddress !== 'string') {
      throw new AppError('Treasury address is required.', StatusCodes.BAD_REQUEST);
    }

    if (!businessMetadata || typeof businessMetadata !== 'object') {
      throw new AppError('Business metadata is required.', StatusCodes.BAD_REQUEST);
    }

    const fleet = await Fleet.create({
      name: name.trim(),
      treasuryAddress: (treasuryAddress as string).trim(),
      ownerId: owner._id,
      members: [{ userId: owner._id, role: 'admin', joinedAt: new Date() }],
      businessMetadata: {
        companyName: businessMetadata.companyName,
        industry: businessMetadata.industry || '',
        registrationNumber: businessMetadata.registrationNumber || '',
        vatNumber: businessMetadata.vatNumber || '',
        address: businessMetadata.address || {},
        contactEmail: businessMetadata.contactEmail,
        contactPhone: businessMetadata.contactPhone || '',
        website: businessMetadata.website || '',
      },
      isActive: true,
    });

    sendSuccess(res, { fleet }, 'Fleet created successfully.', StatusCodes.CREATED);
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/v1/fleets/:id/invite
 */
export const inviteDriver = async (
  req: Request<{ id: string }, unknown, InviteDriverBody>,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const owner = (req as Request & { user?: IUser }).user;
    if (!owner) {
      throw new AppError('Authentication required.', StatusCodes.UNAUTHORIZED);
    }

    const { id: fleetId } = req.params;
    const { driverId } = req.body;

    if (!driverId || typeof driverId !== 'string') {
      throw new AppError('driverId is required.', StatusCodes.BAD_REQUEST);
    }

    const invitation = await inviteDriverService({
      fleetId,
      driverId,
      invitedBy: owner._id.toString(),
    });

    sendSuccess(res, { invitation }, 'Invitation sent successfully.', StatusCodes.CREATED);
  } catch (error) {
    next(error);
  }
};

/**
 * PATCH /api/v1/fleets/invitations/:invitationId
 */
export const respondToInvitation = async (
  req: Request<{ invitationId: string }, unknown, RespondToInvitationBody>,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const driver = (req as Request & { user?: IUser }).user;
    if (!driver) {
      throw new AppError('Authentication required.', StatusCodes.UNAUTHORIZED);
    }

    const { invitationId } = req.params;
    const { accept } = req.body;

    if (typeof accept !== 'boolean') {
      throw new AppError('accept must be a boolean value.', StatusCodes.BAD_REQUEST);
    }

    const invitation = await respondToInvitationService({
      invitationId,
      driverId: driver._id.toString(),
      accept,
    });

    sendSuccess(
      res,
      { invitation },
      `Invitation ${invitation.status} successfully.`,
      StatusCodes.OK,
    );
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/v1/fleets/:id/metrics
 */
export const getFleetMetrics = async (
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const owner = (req as Request & { user?: IUser }).user;
    if (!owner) {
      throw new AppError('Authentication required.', StatusCodes.UNAUTHORIZED);
    }

    const { id: fleetId } = req.params;
    const metrics = await getFleetMetricsService(fleetId, owner._id.toString());

    sendSuccess(res, { metrics }, 'Fleet metrics retrieved successfully', StatusCodes.OK);
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/v1/fleets
 */
export const getAllFleets = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const user = (req as Request & { user?: IUser }).user;
    if (!user) {
      throw new AppError('Authentication required.', StatusCodes.UNAUTHORIZED);
    }

    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const skip = (page - 1) * limit;

    const fleets = await Fleet.find({ isActive: true })
      .skip(skip)
      .limit(limit)
      .sort({ createdAt: -1 })
      .populate('ownerId', 'name email')
      .populate('members.userId', 'name email role');

    const total = await Fleet.countDocuments({ isActive: true });

    sendSuccess(
      res,
      {
        fleets,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
        },
      },
      'Fleets retrieved successfully',
      StatusCodes.OK,
    );
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/v1/fleets/:id
 */
export const getFleetById = async (
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const user = (req as Request & { user?: IUser }).user;
    if (!user) {
      throw new AppError('Authentication required.', StatusCodes.UNAUTHORIZED);
    }

    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new AppError('Invalid fleet ID format.', StatusCodes.BAD_REQUEST);
    }

    const fleet = await Fleet.findById(id)
      .populate('ownerId', 'name email')
      .populate('members.userId', 'name email role');

    if (!fleet) {
      throw new AppError('Fleet not found.', StatusCodes.NOT_FOUND);
    }

    sendSuccess(res, { fleet }, 'Fleet retrieved successfully', StatusCodes.OK);
  } catch (error) {
    next(error);
  }
};

/**
 * PUT /api/v1/fleets/:id
 */
export const updateFleet = async (
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const user = (req as Request & { user?: IUser }).user;
    if (!user) {
      throw new AppError('Authentication required.', StatusCodes.UNAUTHORIZED);
    }

    const { id } = req.params;
    const updateData = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new AppError('Invalid fleet ID format.', StatusCodes.BAD_REQUEST);
    }

    const fleet = await Fleet.findById(id);
    if (!fleet) {
      throw new AppError('Fleet not found.', StatusCodes.NOT_FOUND);
    }

    if (fleet.ownerId.toString() !== user._id.toString()) {
      throw new AppError('Only the fleet owner can update this fleet.', StatusCodes.FORBIDDEN);
    }

    delete updateData.ownerId;
    delete updateData._id;
    delete updateData.createdAt;
    delete updateData.members;

    const updatedFleet = await Fleet.findByIdAndUpdate(
      id,
      { ...updateData, updatedAt: new Date() },
      { new: true, runValidators: true },
    )
      .populate('ownerId', 'name email')
      .populate('members.userId', 'name email role');

    sendSuccess(res, { fleet: updatedFleet }, 'Fleet updated successfully.', StatusCodes.OK);
  } catch (error) {
    next(error);
  }
};

/**
 * DELETE /api/v1/fleets/:id
 */
export const deleteFleet = async (
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const user = (req as Request & { user?: IUser }).user;
    if (!user) {
      throw new AppError('Authentication required.', StatusCodes.UNAUTHORIZED);
    }

    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new AppError('Invalid fleet ID format.', StatusCodes.BAD_REQUEST);
    }

    const fleet = await Fleet.findById(id);
    if (!fleet) {
      throw new AppError('Fleet not found.', StatusCodes.NOT_FOUND);
    }

    if (fleet.ownerId.toString() !== user._id.toString()) {
      throw new AppError('Only the fleet owner can delete this fleet.', StatusCodes.FORBIDDEN);
    }

    fleet.isActive = false;
    await fleet.save();

    sendSuccess(res, null, 'Fleet deleted successfully.', StatusCodes.OK);
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/v1/fleets/:id/members
 */
export const addMember = async (
  req: Request<{ id: string }, unknown, { userId: string; role?: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const user = (req as Request & { user?: IUser }).user;
    if (!user) {
      throw new AppError('Authentication required.', StatusCodes.UNAUTHORIZED);
    }

    const { id } = req.params;
    const { userId, role = 'driver' } = req.body;

    if (!userId) {
      throw new AppError('userId is required.', StatusCodes.BAD_REQUEST);
    }

    if (!mongoose.Types.ObjectId.isValid(id) || !mongoose.Types.ObjectId.isValid(userId)) {
      throw new AppError('Invalid ID format.', StatusCodes.BAD_REQUEST);
    }

    const memberUser = await User.findById(userId);
    if (!memberUser) {
      throw new AppError('User not found.', StatusCodes.NOT_FOUND);
    }

    const fleet = await Fleet.findById(id);
    if (!fleet) {
      throw new AppError('Fleet not found.', StatusCodes.NOT_FOUND);
    }

    if (fleet.ownerId.toString() !== user._id.toString()) {
      throw new AppError('Only the fleet owner can add members.', StatusCodes.FORBIDDEN);
    }

    const isMember = fleet.members.some((m) => m.userId.toString() === userId);
    if (isMember) {
      throw new AppError('User is already a member of this fleet.', StatusCodes.CONFLICT);
    }

    fleet.members.push({
      userId: new mongoose.Types.ObjectId(userId),
      role: role as 'admin' | 'driver' | 'viewer',
      joinedAt: new Date(),
    });

    await fleet.save();
    await fleet.populate('ownerId', 'name email');
    await fleet.populate('members.userId', 'name email role');

    sendSuccess(res, { fleet }, 'Member added successfully.', StatusCodes.CREATED);
  } catch (error) {
    next(error);
  }
};

/**
 * DELETE /api/v1/fleets/:id/members/:userId
 */
export const removeMember = async (
  req: Request<{ id: string; userId: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const user = (req as Request & { user?: IUser }).user;
    if (!user) {
      throw new AppError('Authentication required.', StatusCodes.UNAUTHORIZED);
    }

    const { id, userId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id) || !mongoose.Types.ObjectId.isValid(userId)) {
      throw new AppError('Invalid ID format.', StatusCodes.BAD_REQUEST);
    }

    const fleet = await Fleet.findById(id);
    if (!fleet) {
      throw new AppError('Fleet not found.', StatusCodes.NOT_FOUND);
    }

    if (fleet.ownerId.toString() !== user._id.toString()) {
      throw new AppError('Only the fleet owner can remove members.', StatusCodes.FORBIDDEN);
    }

    if (fleet.ownerId.toString() === userId) {
      throw new AppError('Cannot remove the fleet owner.', StatusCodes.BAD_REQUEST);
    }

    const memberIndex = fleet.members.findIndex((m) => m.userId.toString() === userId);

    if (memberIndex === -1) {
      throw new AppError('Member not found in this fleet.', StatusCodes.NOT_FOUND);
    }

    fleet.members.splice(memberIndex, 1);
    await fleet.save();

    sendSuccess(res, null, 'Member removed successfully.', StatusCodes.OK);
  } catch (error) {
    next(error);
  }
};
