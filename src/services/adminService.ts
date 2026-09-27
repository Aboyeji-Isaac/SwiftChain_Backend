import { StatusCodes } from 'http-status-codes';
import mongoose from 'mongoose';
import User from '../models/User';
import Dispute, { DisputeStatus, IDispute } from '../models/Dispute';
import { IUser, UserRole, UserStatus } from '../interfaces/IUser';
import AppError from '../utils/AppError';
import logger from '../config/logger';

// ─── DTOs ──────────────────────────────────────────────────────────────────────

export interface SuspendUserInput {
  /** MongoDB ObjectId string of the target user. */
  targetUserId: string;
  /** MongoDB ObjectId string of the admin performing the action. */
  adminId: string;
  /** Human-readable reason required for the audit trail. */
  reason: string;
  /**
   * Whether to apply a full ban instead of a temporary suspension.
   * Defaults to false (suspension).
   */
  ban?: boolean;
}

export interface SuspendUserResult {
  user: IUser;
  action: 'suspended' | 'banned';
}

// ─── Service ───────────────────────────────────────────────────────────────────

/**
 * Suspends or bans a user account.
 *
 * Business rules enforced here:
 *  - Target user must exist.
 *  - An admin cannot suspend or ban themselves.
 *  - An admin cannot suspend or ban another admin (privilege escalation guard).
 *  - A user already in the desired status is a no-op that returns 409.
 *  - `reason` is mandatory for audit purposes.
 */
export const suspendUser = async (input: SuspendUserInput): Promise<SuspendUserResult> => {
  const { targetUserId, adminId, reason, ban = false } = input;

  // 1. Validate the target ID is a valid ObjectId before hitting the DB
  if (!mongoose.Types.ObjectId.isValid(targetUserId)) {
    throw new AppError('Invalid user ID format.', StatusCodes.BAD_REQUEST);
  }

  // 2. Self-action guard
  if (targetUserId === adminId) {
    throw new AppError(
      'Admins cannot suspend or ban their own account.',
      StatusCodes.UNPROCESSABLE_ENTITY,
    );
  }

  // 3. Load the target user
  const targetUser = await User.findById(targetUserId);
  if (!targetUser) {
    throw new AppError('User not found.', StatusCodes.NOT_FOUND);
  }

  // 4. Privilege escalation guard — admins cannot action other admins
  if (targetUser.role === UserRole.ADMIN) {
    throw new AppError(
      'Admin accounts cannot be suspended or banned by another admin.',
      StatusCodes.FORBIDDEN,
    );
  }

  const desiredStatus: UserStatus = ban ? UserStatus.BANNED : UserStatus.SUSPENDED;

  // 5. Idempotency — already in the desired state
  if (targetUser.status === desiredStatus) {
    throw new AppError(`User is already ${desiredStatus}.`, StatusCodes.CONFLICT);
  }

  // 6. Apply the status change with audit metadata
  targetUser.status = desiredStatus;
  targetUser.suspendedAt = new Date();
  targetUser.suspendedReason = reason;

  await targetUser.save();

  logger.info(`Admin ${adminId} ${desiredStatus} user ${targetUserId}. Reason: "${reason}"`);

  return { user: targetUser, action: desiredStatus };
};

// ─── Disputes Service DTOs ───────────────────────────────────────────────────

export interface GetAdminDisputesInput {
  page?: number;
  limit?: number;
  status?: string;
}

export interface GetAdminDisputesResult {
  disputes: IDispute[];
  pagination: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}

/**
 * Retrieves a paginated list of disputes for the admin dashboard.
 *
 * Filtering rules:
 * - If no `status` filter is provided, defaults to active disputes (`open` & `under_review`).
 * - If `status` is `'active'`, filters for active disputes (`open` & `under_review`).
 * - If `status` is `'all'`, returns disputes across all statuses.
 * - If `status` matches a specific `DisputeStatus` (e.g. `open`, `under_review`, `resolved`, `rejected`), filters by that status.
 * - If `status` is invalid, throws a 400 Bad Request AppError.
 */
export const getAdminDisputes = async (
  input: GetAdminDisputesInput,
): Promise<GetAdminDisputesResult> => {
  const page = Math.max(1, input.page ?? 1);
  const limit = Math.min(100, Math.max(1, input.limit ?? 10));
  const skip = (page - 1) * limit;

  const queryFilter: Record<string, unknown> = {};

  if (input.status) {
    const statusLower = input.status.trim().toLowerCase();

    if (statusLower === 'active') {
      queryFilter.status = { $in: [DisputeStatus.OPEN, DisputeStatus.UNDER_REVIEW] };
    } else if (statusLower === 'all') {
      // No status restriction
    } else if (Object.values(DisputeStatus).includes(statusLower as DisputeStatus)) {
      queryFilter.status = statusLower;
    } else {
      const validStatuses = Object.values(DisputeStatus).join(', ');
      throw new AppError(
        `Invalid dispute status '${input.status}'. Allowed values: ${validStatuses}, active, all.`,
        StatusCodes.BAD_REQUEST,
      );
    }
  } else {
    // Default filter when no status query parameter is supplied: active disputes
    queryFilter.status = { $in: [DisputeStatus.OPEN, DisputeStatus.UNDER_REVIEW] };
  }

  const [disputes, total] = await Promise.all([
    Dispute.find(queryFilter).sort({ createdAt: -1 }).skip(skip).limit(limit).exec(),
    Dispute.countDocuments(queryFilter),
  ]);

  const totalPages = Math.ceil(total / limit) || 0;

  return {
    disputes,
    pagination: {
      total,
      page,
      limit,
      totalPages,
    },
  };
};
