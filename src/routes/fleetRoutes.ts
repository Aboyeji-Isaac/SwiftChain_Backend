import { Router } from 'express';
import authenticate from '../middleware/authenticate';
import requireRole from '../middleware/requireRole';
import {
  createFleet,
  inviteDriver,
  respondToInvitation,
  getFleetMetrics,
  getAllFleets,
  getFleetById,
  updateFleet,
  deleteFleet,
  addMember,
  removeMember,
} from '../controllers/fleetController';
import { UserRole } from '../interfaces/IUser';

const router = Router();

// All fleet routes require a valid JWT.
router.use(authenticate);

/**
 * @route   POST /api/v1/fleets
 * @desc    Create a new fleet
 * @access  Enterprise only
 */
router.post('/', requireRole(UserRole.ENTERPRISE), createFleet);

/**
 * @route   GET /api/v1/fleets
 * @desc    Get all fleets (paginated)
 * @access  Enterprise/Admin
 */
router.get('/', requireRole(UserRole.ENTERPRISE), getAllFleets);

/**
 * @route   GET /api/v1/fleets/:id
 * @desc    Get a single fleet by ID
 * @access  Authenticated (fleet owner or member)
 */
router.get('/:id', getFleetById);

/**
 * @route   PUT /api/v1/fleets/:id
 * @desc    Update a fleet
 * @access  Enterprise (fleet owner only)
 */
router.put('/:id', requireRole(UserRole.ENTERPRISE), updateFleet);

/**
 * @route   DELETE /api/v1/fleets/:id
 * @desc    Soft delete a fleet
 * @access  Enterprise (fleet owner only)
 */
router.delete('/:id', requireRole(UserRole.ENTERPRISE), deleteFleet);

/**
 * @route   POST /api/v1/fleets/:id/members
 * @desc    Add a member to the fleet
 * @access  Enterprise (fleet owner only)
 */
router.post('/:id/members', requireRole(UserRole.ENTERPRISE), addMember);

/**
 * @route   DELETE /api/v1/fleets/:id/members/:userId
 * @desc    Remove a member from the fleet
 * @access  Enterprise (fleet owner only)
 */
router.delete('/:id/members/:userId', requireRole(UserRole.ENTERPRISE), removeMember);

/**
 * @route   POST /api/v1/fleets/:id/invite
 * @desc    Invite a driver to join the fleet
 * @access  Enterprise only (must be the fleet owner)
 */
router.post('/:id/invite', requireRole(UserRole.ENTERPRISE), inviteDriver);

/**
 * @route   PATCH /api/v1/fleets/invitations/:invitationId
 * @desc    Driver accepts or declines a pending fleet invitation
 * @access  Driver only
 */
router.patch('/invitations/:invitationId', requireRole(UserRole.DRIVER), respondToInvitation);

/**
 * @route   GET /api/v1/fleets/:id/metrics
 * @desc    Aggregated delivery and revenue statistics for a fleet
 * @access  Enterprise only (must be the fleet owner)
 */
router.get('/:id/metrics', requireRole(UserRole.ENTERPRISE), getFleetMetrics);

export default router;
