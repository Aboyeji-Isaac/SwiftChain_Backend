import { Router } from 'express';
import userController from '../controllers/userController';
import { authMiddleware } from '../middlewares/authMiddleware';
import requireRole from '../middleware/requireRole';
import validate from '../middleware/validate';
import { updateWalletSchema } from '../validators/userValidator';
import { UserRole } from '../interfaces/IUser';

const router = Router();

/**
 * @route   PUT /api/v1/users/wallet
 * @desc    Link or update the authenticated user's Stellar wallet address
 * @access  Private
 */
router.put(
  '/wallet',
  authMiddleware,
  validate({ body: updateWalletSchema }),
  userController.updateWallet,
);

/**
 * @route   GET /api/v1/users/deleted
 * @desc    List soft-deleted users
 * @access  Private (Admin only)
 */
router.get(
  '/deleted',
  authMiddleware,
  requireRole(UserRole.ADMIN),
  userController.listDeletedUsers,
);

/**
 * @route   GET /api/v1/users/:id
 * @desc    Get user by ID
 * @access  Private
 */
router.get('/:id', authMiddleware, userController.getUserById);

/**
 * @route   PUT /api/v1/users/:id
 * @desc    Update user profile
 * @access  Private (Admin only)
 */
router.put('/:id', authMiddleware, requireRole(UserRole.ADMIN), userController.updateUser);

/**
 * @route   DELETE /api/v1/users/:id
 * @desc    Soft delete user with cascading to related records
 * @access  Private (Admin only)
 */
router.delete('/:id', authMiddleware, requireRole(UserRole.ADMIN), userController.deleteUser);

/**
 * @route   POST /api/v1/users/:id/restore
 * @desc    Restore a soft-deleted user
 * @access  Private (Admin only)
 */
router.post(
  '/:id/restore',
  authMiddleware,
  requireRole(UserRole.ADMIN),
  userController.restoreUser,
);

/**
 * @route   PUT /api/v1/users/:id/password
 * @desc    Update user password
 * @access  Private (own user only)
 */
router.put('/:id/password', authMiddleware, userController.updatePassword);

export default router;
