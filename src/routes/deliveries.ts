import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth';
import validateRequest from '../middleware/validate';
import { updateDeliveryStatus } from '../controllers/deliveryStatusController';
import { updateDeliveryStatusSchema } from '../validators/deliveryValidator';

const router = Router();

/**
 * @openapi
 * /v1/deliveries/{id}/status:
 *   put:
 *     tags: [Delivery Status]
 *     summary: Transition a delivery to its next status
 *     description: >     *     Restricted to drivers and admins. Delegates to the canonical
 *     DeliveryService state machine (pending -> funded -> assigned ->
 *     in_progress -> completed / cancelled); legacy vocabulary
 *     (picked_up/in_transit/delivered) is rejected explicitly.
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
 *             $ref: '#/components/schemas/UpdateDeliveryStatusRequest'
 *     responses:
 *       200:
 *         description: Status updated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/DeliveryResponse'
 *       400:
 *         description: Invalid delivery id, invalid status value, or invalid transition
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
 */
router.put(
  '/:id/status',
  authenticate,
  authorize(['driver', 'admin']),
  validateRequest({ body: updateDeliveryStatusSchema }),
  updateDeliveryStatus,
);

export default router;
