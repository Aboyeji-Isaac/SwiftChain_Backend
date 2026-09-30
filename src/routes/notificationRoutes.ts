import { Router } from 'express';
import authenticate from '../middleware/authenticate';
import validate from '../middleware/validate';
import { buildQueryOptions } from '../middlewares/queryMiddleware';
import {
  getPreferences,
  listNotifications,
  registerDevice,
  registerDeviceSchema,
  unregisterDevice,
  unregisterDeviceSchema,
  updatePreferences,
  updatePreferencesSchema,
} from '../controllers/notificationController';

const router = Router();

/**
 * Every notification route acts on the authenticated user's own records.
 * No handler accepts a user id from the client.
 */
router.use(authenticate);

/**
 * @route   GET /api/v1/notifications
 * @desc    Paginated notification history for the authenticated user
 * @access  Private
 */
router.get(
  '/',
  buildQueryOptions({
    sortableFields: ['createdAt'],
    filterableFields: {
      status: 'string',
      event: 'string',
    },
    defaultSort: { createdAt: -1 },
    defaultLimit: 20,
  }),
  listNotifications,
);

/**
 * @route   GET /api/v1/notifications/preferences
 * @desc    Read notification preferences (defaults created on first access)
 * @access  Private
 */
router.get('/preferences', getPreferences);

/**
 * @route   PATCH /api/v1/notifications/preferences
 * @desc    Enable/disable push and choose which events to receive
 * @access  Private
 */
router.patch('/preferences', validate({ body: updatePreferencesSchema }), updatePreferences);

/**
 * @route   POST /api/v1/notifications/devices
 * @desc    Register or refresh a device push token
 * @access  Private
 */
router.post('/devices', validate({ body: registerDeviceSchema }), registerDevice);

/**
 * @route   DELETE /api/v1/notifications/devices
 * @desc    Remove a device push token
 * @access  Private
 */
router.delete('/devices', validate({ body: unregisterDeviceSchema }), unregisterDevice);

export default router;
