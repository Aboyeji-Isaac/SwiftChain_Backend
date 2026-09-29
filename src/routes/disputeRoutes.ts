import { Router } from 'express';
import authenticate from '../middleware/authenticate';
import requireRole from '../middleware/requireRole';
import validate from '../middleware/validate';
import { UserRole } from '../interfaces/IUser';
import {
  openDispute,
  getDispute,
  listDisputes,
  resolveDisputeController,
  addEvidenceController,
  updateDisputeController,
} from '../controllers/disputeController';
import {
  createDisputeSchema,
  resolveDisputeSchema,
  addEvidenceSchema,
  updateDisputeSchema,
} from '../validators/disputeValidator';

const router = Router();

/**
 * @route   POST /api/v1/disputes
 * @desc    Open a delivery dispute before any on-chain dispute workflow runs
 * @access  Authenticated users (delivery customer or driver)
 */
router.post('/', authenticate, validate({ body: createDisputeSchema }), openDispute);

/**
 * @route   GET /api/v1/disputes
 * @desc    List disputes with optional filtering
 * @access  Admin only — the query is not scoped to the caller, so exposing it
 *          to every authenticated user would leak other users' disputes.
 */
router.get('/', authenticate, requireRole(UserRole.ADMIN), listDisputes);

/**
 * @route   GET /api/v1/disputes/:id
 * @desc    Get a single dispute by ID
 * @access  Authenticated users
 */
router.get('/:id', authenticate, getDispute);

/**
 * @route   PATCH /api/v1/disputes/:id/evidence
 * @desc    Add evidence URLs to an open dispute
 * @access  Authenticated users (dispute raiser or driver)
 */
router.patch(
  '/:id/evidence',
  authenticate,
  validate({ body: addEvidenceSchema }),
  addEvidenceController,
);

/**
 * @route   PATCH /api/v1/disputes/:id/resolve
 * @desc    Resolve or reject a dispute with resolution notes
 * @access  Authenticated users (admin or dispute participant)
 */
router.patch(
  '/:id/resolve',
  authenticate,
  validate({ body: resolveDisputeSchema }),
  resolveDisputeController,
);

/**
 * @route   PATCH /api/v1/disputes/:id
 * @desc    Update dispute metadata (reason, description, evidence)
 * @access  Authenticated users (dispute raiser or admin)
 */
router.patch(
  '/:id',
  authenticate,
  validate({ body: updateDisputeSchema }),
  updateDisputeController,
);

export default router;
