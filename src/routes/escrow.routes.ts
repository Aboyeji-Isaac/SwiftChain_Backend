import { Router } from 'express';
import { escrowController } from '../controllers/escrow.controller';
import { validateRequest } from '../middlewares/validateRequest';
import { requireIdempotencyKey } from '../middlewares/idempotency';
import { fundEscrowBodySchema } from '../validators/escrowValidator';
import authenticate from '../middleware/authenticate';

/**
 * Escrow routes.
 *
 * Mounted at /api/v1/escrow by the root router.
 *
 * Endpoints:
 *   POST /api/v1/escrow/fund                  — record an on-chain escrow_funded event (idempotent)
 *   GET  /api/v1/escrow/delivery/:deliveryId  — escrow record for a delivery
 *   GET  /api/v1/escrow/contract/:contractId  — escrow record for a contract id
 *   POST /api/v1/escrow/sync                  — manually trigger an escrow_funded indexer poll
 *   POST /api/v1/escrow/release               — release an escrow with distributed locking
 */
const router = Router();

/**
 * @openapi
 * /v1/escrow/fund:
 *   post:
 *     tags: [Escrow]
 *     summary: Fund (record) an escrow for a delivery
 *     description: |
 *       Records an on-chain `escrow_funded` event against a delivery and
 *       marks the delivery as FUNDED.
 *
 *       This endpoint requires an `Idempotency-Key` header (UUID v4
 *       recommended).  Submitting the same key a second time returns the
 *       original response without re-executing the operation, preventing
 *       duplicate charges on network retries.
 *
 *       The endpoint is also idempotent at the transaction level: replaying
 *       the same `transactionHash` is a no-op regardless of the
 *       Idempotency-Key.
 *     parameters:
 *       - in: header
 *         name: Idempotency-Key
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: |
 *           Unique key (UUID v4 recommended) scoped to this request.
 *           Duplicate requests with the same key return the cached response.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/FundEscrowRequest'
 *     responses:
 *       201:
 *         description: Escrow funded and delivery status set to FUNDED
 *         headers:
 *           Idempotency-Key-Status:
 *             schema:
 *               type: string
 *               enum: [completed, failed]
 *             description: Lifecycle state of the idempotency record.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/EscrowResponse'
 *       409:
 *         description: |
 *           Duplicate idempotency key while the original request is still
 *           in-flight, or a conflicting escrow already exists.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       422:
 *         description: Missing or malformed Idempotency-Key header
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.use(authenticate);

router.post(
  '/fund',
  requireIdempotencyKey,
  validateRequest({ body: fundEscrowBodySchema }),
  escrowController.fund.bind(escrowController),
);

// Every escrow endpoint, including fund, requires a valid JWT.

router.get('/delivery/:deliveryId', escrowController.getByDelivery.bind(escrowController));
router.get('/contract/:contractId', escrowController.getByContract.bind(escrowController));
router.post('/sync', escrowController.sync.bind(escrowController));
router.post('/release', escrowController.release.bind(escrowController));

export default router;
