import { Router } from 'express';
import { driverController } from '../controllers/driverController';
import { driverLocationController } from '../controllers/driverLocationController';
import { getDriverEarnings } from '../controllers/driverEarningsController';
import { driverRatingController } from '../controllers/driverRatingController';
import authenticate from '../middleware/authenticate';
import requireRole from '../middleware/requireRole';
import { UserRole } from '../interfaces/IUser';

const router = Router();

/**
 * @route  GET /api/v1/drivers/leaderboard
 * @desc   Fetch top drivers ranked by reputation points
 * @access Public
 */
router.get('/leaderboard', driverController.getLeaderboard.bind(driverController));

/**
 * @route  PATCH /api/v1/drivers/me/vehicle
 * @desc   Create or update the authenticated driver's vehicle details
 * @access Driver only
 */
router.patch(
  '/me/vehicle',
  authenticate,
  requireRole(UserRole.DRIVER),
  driverController.setVehicleDetails.bind(driverController),
);

/**
 * @route  GET /api/v1/drivers/nearby
 * @desc   Find drivers near a coordinate, nearest first, using the 2dsphere index
 * @access Authenticated
 */
router.get(
  '/nearby',
  authenticate,
  driverLocationController.getNearbyDrivers.bind(driverLocationController),
);

/**
 * @route  GET /api/v1/drivers/nearby/explain
 * @desc   Report the query plan and index used by the proximity search
 * @access Admin only
 */
router.get(
  '/nearby/explain',
  authenticate,
  requireRole(UserRole.ADMIN),
  driverLocationController.explainNearbyQuery.bind(driverLocationController),
);

/**
 * @route  PUT /api/v1/drivers/me/location
 * @desc   Record the authenticated driver's current position
 * @access Driver only
 */
router.put(
  '/me/location',
  authenticate,
  requireRole(UserRole.DRIVER),
  driverLocationController.updateMyLocation.bind(driverLocationController),
);

/**
 * @route  GET /api/v1/drivers/:driverId/location
 * @desc   Fetch a single driver's most recent position
 * @access Authenticated
 */
router.get(
  '/:driverId/location',
  authenticate,
  driverLocationController.getDriverLocation.bind(driverLocationController),
);

/**
 * @route  GET /api/v1/drivers/:id/earnings
 * @desc   Aggregate a driver's earnings by day/week/month from released escrows
 * @access The driver themselves, or an admin
 */
router.get('/:id/earnings', authenticate, getDriverEarnings);

/**
 * @openapi
 * /v1/drivers/{driverId}/rating:
 *   get:
 *     tags: [Drivers]
 *     summary: Get a driver's performance rating
 *     description: |
 *       Returns the driver's stored rating (0–5), penalty state and the
 *       delivery counters it was derived from. A driver may only read their
 *       own rating; an admin may read any driver's rating.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: driverId
 *         required: true
 *         schema:
 *           type: string
 *         description: MongoDB ObjectId of the driver (user id)
 *     responses:
 *       200:
 *         description: Rating retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/DriverRatingResponse'
 *       400:
 *         description: Malformed driver id
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       403:
 *         description: Not the driver themselves and not an admin
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.get(
  '/:driverId/rating',
  authenticate,
  driverRatingController.getDriverRating.bind(driverRatingController),
);

/**
 * @openapi
 * /v1/drivers/{driverId}/rating/recalculate:
 *   post:
 *     tags: [Drivers]
 *     summary: Recalculate a driver's rating and apply penalties
 *     description: |
 *       Recomputes the driver's rating from their live delivery history and
 *       applies a temporary suspension when the score is extremely low.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: driverId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Rating recalculated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/DriverRatingResponse'
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
router.post(
  '/:driverId/rating/recalculate',
  authenticate,
  requireRole(UserRole.ADMIN),
  driverRatingController.recalculateDriverRating.bind(driverRatingController),
);

/**
 * @openapi
 * /v1/drivers/rating/recalculate:
 *   post:
 *     tags: [Drivers]
 *     summary: Recalculate every driver's rating
 *     description: |
 *       Sweeps every driver with delivery history, refreshes their rating and
 *       lifts suspensions that have lapsed. Admin only.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Sweep completed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   properties:
 *                     result:
 *                       $ref: '#/components/schemas/RecalculateRatingsResult'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
router.post(
  '/rating/recalculate',
  authenticate,
  requireRole(UserRole.ADMIN),
  driverRatingController.recalculateAllRatings.bind(driverRatingController),
);

export default router;
