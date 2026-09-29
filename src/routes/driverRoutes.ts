import { Router } from 'express';
import { driverController } from '../controllers/driverController';
import { driverLocationController } from '../controllers/driverLocationController';
import { getDriverEarnings } from '../controllers/driverEarningsController';
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

export default router;
