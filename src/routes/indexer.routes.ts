/**
 * Delivery-created indexer routes.
 *
 * Mounted at /api/v1/indexer by the root router. Receives contract events
 * pushed by the indexer worker.
 *
 * Endpoints:
 *   POST /api/v1/indexer/delivery-created — process a delivery_created event
 */
import { Router } from 'express';
import { indexerController } from '../controllers/indexer.controller';

const router = Router();

/**
 * @openapi
 * /v1/indexer/delivery-created:
 *   post:
 *     tags: [Indexer]
 *     summary: Process a delivery_created contract event
 *     description: |
 *       Accepts a base64-encoded Soroban event payload posted by the indexer
 *       worker and applies the corresponding delivery state transition.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [payload]
 *             properties:
 *               payload:
 *                 type: string
 *                 description: Base64-encoded delivery_created event payload (XDR)
 *     responses:
 *       200:
 *         description: Delivery updated from the event
 *       400:
 *         description: Missing payload in request body
 *       500:
 *         description: Event could not be processed
 */
router.post('/delivery-created', indexerController.handleDeliveryCreated.bind(indexerController));

export default router;
