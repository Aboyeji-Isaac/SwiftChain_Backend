import { Router } from 'express';
import authenticate from '../middleware/authenticate';
import requireRole from '../middleware/requireRole';
import { buildQueryOptions } from '../middlewares/queryMiddleware';
import {
  listFlaggedEscrows,
  resolveFlaggedEscrow,
  retryExpiredEscrow,
} from '../controllers/escrowController';
import { UserRole } from '../interfaces/IUser';

/** Admin escrow review/resolution. Mounted at /api/v1/admin/escrows by the root router. */
const router = Router();

router.use(authenticate);
router.use(requireRole(UserRole.ADMIN));

/**
 * @openapi
 * /v1/admin/escrows/flagged:
 *   get:
 *     tags: [Admin]
 *     summary: List escrows flagged for admin review
 *     description: Admin-only. Disputed, expired, and suspicious escrows, paginated.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [disputed, expired, suspicious]
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20, maximum: 100 }
 *       - in: query
 *         name: sort
 *         schema: { type: string, example: '-updatedAt' }
 *     responses:
 *       200:
 *         description: Paginated list of flagged escrows
 *       403:
 *         description: Caller is not an admin
 */
router.get(
  '/flagged',
  buildQueryOptions({
    sortableFields: ['updatedAt', 'createdAt', 'flaggedAt', 'expiresAt', 'amount'],
    filterableFields: {},
    defaultSort: { updatedAt: -1 },
    defaultLimit: 20,
    maxLimit: 100,
  }),
  listFlaggedEscrows,
);

/**
 * @openapi
 * /v1/admin/escrows/{id}/resolve:
 *   patch:
 *     tags: [Admin]
 *     summary: Resolve a flagged escrow
 *     description: >
 *       Admin-only. Release to driver, refund to payer, or keep locked (with a
 *       fresh expiry). Terminal escrows cannot be resolved. Audit-logged.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [resolution, reason]
 *             properties:
 *               resolution:
 *                 type: string
 *                 enum: [release_to_driver, refund_to_payer, keep_locked]
 *               reason:
 *                 type: string
 *     responses:
 *       200:
 *         description: Escrow resolved
 *       400:
 *         description: Invalid resolution, reason, or escrow id
 *       404:
 *         description: Escrow not found
 *       409:
 *         description: Escrow is in a terminal status
 */
router.patch('/:id/resolve', resolveFlaggedEscrow);

/**
 * @openapi
 * /v1/admin/escrows/{id}/expired/retry:
 *   post:
 *     tags: [Admin]
 *     summary: Re-fund or cancel an expired escrow
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [action, reason]
 *             properties:
 *               action:
 *                 type: string
 *                 enum: [refund, cancel]
 *               reason:
 *                 type: string
 *     responses:
 *       200:
 *         description: Expired escrow re-funded or cancelled
 *       409:
 *         description: Escrow is not expired
 */
router.post('/:id/expired/retry', retryExpiredEscrow);

export default router;
