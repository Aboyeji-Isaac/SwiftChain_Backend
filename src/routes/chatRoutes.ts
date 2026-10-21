import { Router } from 'express';
import authenticate from '../middleware/authenticate';
import { getDeliveryMessages } from '../controllers/chatController';

/** Delivery chat history. Mounted at /api/v1/deliveries by the root router. */
const router = Router();

/**
 * @openapi
 * /v1/deliveries/{id}/messages:
 *   get:
 *     tags: [Chat]
 *     summary: Paginated chat history for a delivery
 *     description: Restricted to the delivery's sender, recipient, driver, and admins.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 50 }
 *     responses:
 *       200:
 *         description: Chat history page (oldest first within the page)
 *       403:
 *         description: Not a participant of the delivery
 */
router.get('/:id/messages', authenticate, getDeliveryMessages);

export default router;
