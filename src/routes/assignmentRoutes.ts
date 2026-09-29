import { Router } from 'express';
import authenticate from '../middleware/authenticate';
import requireRole from '../middleware/requireRole';
import { UserRole } from '../interfaces/IUser';
import { assignNearestDriver } from '../controllers/assignmentController';

const router = Router();

/**
 * @route   POST /api/v1/deliveries/:id/assign-nearest-driver
 * @desc    Find and assign the nearest available driver to a funded delivery
 * @access  Admin only (dispatchers)
 */
router.post(
  '/:id/assign-nearest-driver',
  authenticate,
  requireRole(UserRole.ADMIN),
  assignNearestDriver,
);

export default router;
