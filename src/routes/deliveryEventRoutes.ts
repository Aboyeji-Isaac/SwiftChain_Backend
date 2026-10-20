import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { listDeliveryMilestones } from '../controllers/deliveryEventController';

const router = Router();

/**
 * @openapi
 * /v1/deliveries/{id}/events:
 *   get:
 *     tags: [Delivery Events]
 *     summary: List a delivery's ordered milestone events
 *     description: >
 *       Returns the append-only milestone log (created, funded, assigned,
 *       in_progress, completed/cancelled) ordered by `seq`. Restricted to the
 *       delivery's participants and admins.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Milestone events, oldest first
 *       400:
 *         description: Invalid delivery id
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.get('/:id/events', authenticate, listDeliveryMilestones);

export default router;
