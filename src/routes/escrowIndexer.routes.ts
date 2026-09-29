/**
 * Escrow Indexer Routes
 *
 * Endpoints for querying escrow indexer state and manually triggering event syncs.
 * Mounted at /api/v1/indexer
 *
 * Endpoints:
 *   GET  /escrows/:escrowId         — retrieve escrow status from database
 *   POST /escrows/sync/released     — manually sync escrow_released events
 *   POST /escrows/sync/refunded     — manually sync escrow_refunded events
 */

import { Router } from 'express';
import { escrowIndexerController } from '../controllers/escrowIndexerController';

const router = Router();

/**
 * @openapi
 * /v1/indexer/escrows/{escrowId}:
 *   get:
 *     tags: [Indexer]
 *     summary: Get escrow status
 *     description: Retrieve the current status of an escrow from the database
 *     parameters:
 *       - in: path
 *         name: escrowId
 *         required: true
 *         schema:
 *           type: string
 *         description: MongoDB ObjectId or contract ID of the escrow
 *     responses:
 *       200:
 *         description: Escrow status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   description: Escrow document
 *                 message:
 *                   type: string
 *       404:
 *         description: Escrow not found
 *       400:
 *         description: Invalid escrowId
 */
router.get('/escrows/:escrowId', (req, res, next) =>
  escrowIndexerController.getEscrowStatus(req, res, next),
);

/**
 * @openapi
 * /v1/indexer/escrows/sync/released:
 *   post:
 *     tags: [Indexer]
 *     summary: Sync escrow_released events
 *     description: |
 *       Manually trigger a poll of the Soroban RPC node for escrow_released events.
 *       Processes all events from startLedger onwards.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - startLedger
 *             properties:
 *               startLedger:
 *                 type: number
 *                 description: Ledger sequence to start from (inclusive)
 *               contractId:
 *                 type: string
 *                 description: Escrow contract ID (optional, defaults to env var)
 *     responses:
 *       200:
 *         description: Events synced successfully
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
 *                     latestLedger:
 *                       type: number
 *                     cursor:
 *                       type: string
 *                     processed:
 *                       type: number
 *                     ignored:
 *                       type: number
 *                 message:
 *                   type: string
 *       400:
 *         description: Invalid parameters
 */
router.post('/escrows/sync/released', (req, res, next) =>
  escrowIndexerController.syncReleased(req, res, next),
);

/**
 * @openapi
 * /v1/indexer/escrows/sync/refunded:
 *   post:
 *     tags: [Indexer]
 *     summary: Sync escrow_refunded events
 *     description: |
 *       Manually trigger a poll of the Soroban RPC node for escrow_refunded events.
 *       Processes all events from startLedger onwards.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - startLedger
 *             properties:
 *               startLedger:
 *                 type: number
 *                 description: Ledger sequence to start from (inclusive)
 *               contractId:
 *                 type: string
 *                 description: Escrow contract ID (optional, defaults to env var)
 *     responses:
 *       200:
 *         description: Events synced successfully
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
 *                     latestLedger:
 *                       type: number
 *                     cursor:
 *                       type: string
 *                     processed:
 *                       type: number
 *                     ignored:
 *                       type: number
 *                 message:
 *                   type: string
 *       400:
 *         description: Invalid parameters
 */
router.post('/escrows/sync/refunded', (req, res, next) =>
  escrowIndexerController.syncRefunded(req, res, next),
);

export default router;
