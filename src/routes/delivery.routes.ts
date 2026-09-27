import { Router } from 'express';
import { deliveryController } from '../controllers/delivery.controller';
import { validateRequest } from '../middlewares/validateRequest';
import { requireIdempotencyKey } from '../middlewares/idempotency';
import {
  createDeliverySchema,
  updateDeliverySchema,
  assignDriverSchema,
} from '../validators/deliveryValidator';
import authenticate from '../middleware/authenticate';
import requireRole from '../middleware/requireRole';
import { UserRole } from '../interfaces/IUser';

const router = Router();

/**
 * @openapi
 * /v1/deliveries:
 *   post:
 *     tags: [Deliveries]
 *     summary: Create a new delivery
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateDeliveryRequest'
 *     responses:
 *       201:
 *         description: Delivery created
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/DeliveryResponse'
 *       409:
 *         description: A delivery with this tracking number already exists
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *   get:
 *     tags: [Deliveries]
 *     summary: List deliveries
 *     description: Returns non-archived deliveries, optionally filtered and paginated.
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [pending, assigned, in_progress, completed, cancelled]
 *       - in: query
 *         name: driver
 *         schema:
 *           type: string
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Matches against tracking number
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *     responses:
 *       200:
 *         description: Paginated list of deliveries
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/DeliveryListResponse'
 */
router.post(
  '/',
  requireIdempotencyKey,
  validateRequest({ body: createDeliverySchema }),
  deliveryController.create.bind(deliveryController),
);

router.get('/', deliveryController.list.bind(deliveryController));

/**
 * @openapi
 * /v1/deliveries/archived:
 *   get:
 *     tags: [Deliveries]
 *     summary: List archived (soft-deleted) deliveries
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *     responses:
 *       200:
 *         description: Paginated list of archived deliveries
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/DeliveryListResponse'
 */
router.get('/archived', deliveryController.listArchived.bind(deliveryController));

/**
 * @openapi
 * /v1/deliveries/{id}:
 *   get:
 *     tags: [Deliveries]
 *     summary: Get a delivery by id
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Delivery found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/DeliveryResponse'
 *       400:
 *         description: Invalid delivery id format
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *   patch:
 *     tags: [Deliveries]
 *     summary: Update a delivery
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
 *             $ref: '#/components/schemas/UpdateDeliveryRequest'
 *     responses:
 *       200:
 *         description: Delivery updated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/DeliveryResponse'
 *       400:
 *         description: Invalid delivery id format
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.get('/:id', deliveryController.getById.bind(deliveryController));

router.patch(
  '/:id',
  validateRequest({ body: updateDeliverySchema }),
  deliveryController.update.bind(deliveryController),
);

/**
 * @openapi
 * /v1/deliveries/{id}/assign-driver:
 *   patch:
 *     tags: [Deliveries]
 *     summary: Assign a driver to a delivery
 *     description: |
 *       Assigns a driver to a delivery **only when the Soroban escrow contract
 *       for that delivery is fully initialised** (lockStatus = LOCKED).
 *
 *       The endpoint enforces the following guard rules in order:
 *         1. Delivery must exist.
 *         2. Delivery must not be in a terminal state (completed / cancelled).
 *         3. Delivery must not already have a driver assigned.
 *         4. An Escrow record must exist for the delivery.
 *         5. The escrow `lockStatus` must be `LOCKED` — pending, released,
 *            refunded or disputed escrows are all rejected with clear messages.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: MongoDB ObjectId of the delivery
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [driverId]
 *             properties:
 *               driverId:
 *                 type: string
 *                 description: The driver identifier to assign
 *     responses:
 *       200:
 *         description: Driver assigned — delivery status advanced to ASSIGNED
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/DeliveryResponse'
 *       400:
 *         description: Invalid delivery id or missing / invalid driverId
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       409:
 *         description: |
 *           Delivery is already assigned, completed or cancelled; OR the
 *           escrow exists but its lockStatus is not LOCKED (pending / released
 *           / refunded / disputed).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       422:
 *         description: No escrow record found — escrow contract was never initialised
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.patch(
  '/:id/assign-driver',
  authenticate,
  requireRole(UserRole.ADMIN),
  validateRequest({ body: assignDriverSchema }),
  deliveryController.assignDriver.bind(deliveryController),
);

/**
 * @openapi
 * /v1/deliveries/{id}/archive:
 *   patch:
 *     tags: [Deliveries]
 *     summary: Archive (soft-delete) a delivery
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Delivery archived
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/DeliveryResponse'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       409:
 *         description: Delivery is already archived
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.patch('/:id/archive', deliveryController.archive.bind(deliveryController));

/**
 * @openapi
 * /v1/deliveries/{id}/restore:
 *   patch:
 *     tags: [Deliveries]
 *     summary: Restore an archived delivery
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Delivery restored
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/DeliveryResponse'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       409:
 *         description: Delivery is not archived
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.patch('/:id/restore', deliveryController.restore.bind(deliveryController));

/**
 * @openapi
 * /v1/deliveries/{id}/qrcode:
 *   get:
 *     tags: [Deliveries]
 *     summary: Generate QR code for delivery handoff verification
 *     description: |
 *       Generates a secure QR code for delivery handoff verification.
 *       QR encodes a delivery ID and a time-limited HMAC-signed token.
 *
 *       The QR code is only generated if the delivery is in the IN_PROGRESS status.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: MongoDB ObjectId of the delivery
 *     responses:
 *       200:
 *         description: QR code generated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     deliveryId:
 *                       type: string
 *                     qrCode:
 *                       type: string
 *                       description: Base64-encoded PNG data URL
 *                     expiresAt:
 *                       type: string
 *                       format: date-time
 *                 message:
 *                   type: string
 *       400:
 *         description: Invalid delivery ID or delivery not eligible for handoff
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.get(
  '/:id/qrcode',
  authenticate,
  deliveryController.generateHandoffQrCode.bind(deliveryController),
);

export default router;
