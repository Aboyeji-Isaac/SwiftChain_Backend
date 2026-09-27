import { Router } from 'express';
import authenticate from '../middleware/authenticate';
import requireRole from '../middleware/requireRole';
import { suspendUser, getDisputes } from '../controllers/adminController';
import { getDashboardMetrics } from '../controllers/dashboardController';
import { dlqController } from '../controllers/dlqController';
import { listFlaggedEscrows, resolveFlaggedEscrow } from '../controllers/escrowController';
import { UserRole } from '../interfaces/IUser';

const router = Router();

// All admin routes require a valid JWT AND the admin role
router.use(authenticate);
router.use(requireRole(UserRole.ADMIN));

/**
 * @openapi
 * /v1/admin/dashboard:
 *   get:
 *     tags: [Admin]
 *     summary: Retrieve real-time admin dashboard system metrics
 *     description: >
 *       Admin-only. Aggregates active deliveries, online drivers, total escrow volume,
 *       and Soroban RPC status. Results are cached in Redis to minimize database load.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: refresh
 *         schema:
 *           type: boolean
 *         description: Set to true to bypass cache and force fresh aggregation
 *     responses:
 *       200:
 *         description: Successfully retrieved system metrics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 message:
 *                   type: string
 *                   example: Admin dashboard metrics retrieved successfully
 *                 data:
 *                   type: object
 *                   properties:
 *                     activeDeliveries:
 *                       type: object
 *                       properties:
 *                         total:
 *                           type: integer
 *                         byStatus:
 *                           type: object
 *                     onlineDrivers:
 *                       type: object
 *                       properties:
 *                         totalActiveDrivers:
 *                           type: integer
 *                         recentlyActiveDrivers:
 *                           type: integer
 *                     escrow:
 *                       type: object
 *                       properties:
 *                         totalVolume:
 *                           type: number
 *                         lockedVolume:
 *                           type: number
 *                         releasedVolume:
 *                           type: number
 *                         refundedVolume:
 *                           type: number
 *                         activeCount:
 *                           type: integer
 *                         totalCount:
 *                           type: integer
 *                     metadata:
 *                       type: object
 *                       properties:
 *                         timestamp:
 *                           type: string
 *                         cached:
 *                           type: boolean
 *                         cacheTtlSeconds:
 *                           type: integer
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         description: Requester is not an admin
 */
router.get('/dashboard', getDashboardMetrics);

/**
 * @openapi
 * /v1/admin/disputes:
 *   get:
 *     tags: [Admin]
 *     summary: Fetch active or filtered disputes for admin dashboard
 *     description: >
 *       Admin-only. Returns a paginated list of delivery disputes.
 *       Defaults to active disputes (`open` and `under_review`) when status query parameter is omitted.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Page number for pagination
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *         description: Items per page (max 100)
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [open, under_review, resolved, rejected, active, all]
 *         description: Filter disputes by status. Defaults to active disputes if omitted.
 *     responses:
 *       200:
 *         description: Successfully retrieved disputes
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Dispute'
 *                 pagination:
 *                   type: object
 *                   properties:
 *                     total:
 *                       type: integer
 *                     page:
 *                       type: integer
 *                     limit:
 *                       type: integer
 *                     totalPages:
 *                       type: integer
 *       400:
 *         description: Invalid query parameters or unsupported status filter
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         description: Requester is not an admin
 */
router.get('/disputes', getDisputes);

/**
 * @openapi
 * /v1/admin/users/{id}/suspend:
 *   put:
 *     tags: [Admin]
 *     summary: Suspend or ban a user or driver account
 *     description: >
 *       Admin-only. An admin cannot suspend themselves or another admin.
 *       Set `ban: true` to permanently ban instead of temporarily suspend.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/SuspendUserRequest'
 *     responses:
 *       200:
 *         description: User suspended or banned
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 message:
 *                   type: string
 *                   example: User has been suspended successfully.
 *                 data:
 *                   type: object
 *                   properties:
 *                     user:
 *                       $ref: '#/components/schemas/User'
 *       400:
 *         description: Missing or invalid reason
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         description: Requester is not an admin, is suspended, or is targeting another admin
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       409:
 *         description: User already in the requested status
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       422:
 *         description: Admin attempted to suspend their own account
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.put('/users/:id/suspend', suspendUser);

/**
 * @openapi
 * /v1/admin/dlq:
 *   get:
 *     tags: [Admin]
 *     summary: Fetch Dead Letter Queue (DLQ) entries
 *     description: Admin-only. Returns a paginated list of failed transaction DLQ entries.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Successfully retrieved DLQ entries
 */
router.get('/dlq', dlqController.getDlqEntries);

/**
 * @openapi
 * /v1/admin/dlq/{id}/retry:
 *   post:
 *     tags: [Admin]
 *     summary: Retry a specific DLQ entry
 *     description: Admin-only. Retries a previously failed transaction.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Successfully retried the DLQ entry
 */
router.post('/dlq/:id/retry', dlqController.retryDlqEntry);

/**
 * @openapi
 * /v1/admin/escrows/flagged:
 *   get:
 *     tags: [Admin]
 *     summary: List escrows flagged as expired for admin review
 *     description: Admin-only. Returns a paginated list of escrows whose lock TTL elapsed.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *         description: 1-based page number (default 1)
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *         description: Items per page (default 20, max 100)
 *     responses:
 *       200:
 *         description: Paginated list of flagged (expired) escrows
 */
router.get('/escrows/flagged', listFlaggedEscrows);

/**
 * @openapi
 * /v1/admin/escrows/{id}/resolve:
 *   patch:
 *     tags: [Admin]
 *     summary: Resolve a flagged (expired) escrow
 *     description: Admin-only. Marks a flagged escrow as resolved and records the audit trail.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [notes]
 *             properties:
 *               notes:
 *                 type: string
 *                 description: Audit trail description of the resolution
 *     responses:
 *       200:
 *         description: Escrow has been resolved successfully
 *       400:
 *         description: Missing or invalid notes / escrow id
 *       404:
 *         description: Escrow not found
 *       409:
 *         description: Escrow is not in the expired state
 */
router.patch('/escrows/:id/resolve', resolveFlaggedEscrow);

export default router;
