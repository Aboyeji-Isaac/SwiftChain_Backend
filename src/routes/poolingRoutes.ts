import { Router } from 'express';
import authenticate from '../middleware/authenticate';
import requireRole from '../middleware/requireRole';
import { UserRole } from '../interfaces/IUser';
import { createPools, poolAndAssign } from '../controllers/poolingController';

const router = Router();

/**
 * @route   POST /api/v1/pooling/create
 * @desc    Cluster nearby pending/funded deliveries into pools
 * @access  Admin
 */
router.post('/create', authenticate, requireRole(UserRole.ADMIN), createPools);

/**
 * @route   POST /api/v1/pooling/assign
 * @desc    Create pools and assign them to nearest available drivers
 * @access  Admin
 */
router.post('/assign', authenticate, requireRole(UserRole.ADMIN), poolAndAssign);

export default router;