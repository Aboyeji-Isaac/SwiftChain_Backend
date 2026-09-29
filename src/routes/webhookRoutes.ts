import { Router } from 'express';
import authenticate from '../middleware/authenticate';
import requireRole from '../middleware/requireRole';
import validate from '../middleware/validate';
import { UserRole } from '../interfaces/IUser';
import {
  registerWebhook,
  listWebhooks,
  getWebhook,
  updateWebhook,
  deleteWebhook,
  rotateWebhookSecret,
} from '../controllers/webhookController';
import { registerWebhookSchema, updateWebhookSchema } from '../validators/webhookValidator';

const router = Router();

// Every webhook route is merchant-scoped, so authentication and the
// merchant/admin role gate apply to the whole router.
router.use(authenticate);
router.use(requireRole(UserRole.ENTERPRISE, UserRole.ADMIN));

/**
 * @route   POST /api/v1/webhooks
 * @desc    Register a new endpoint to receive delivery lifecycle callbacks
 * @access  Merchant (enterprise) or admin
 */
router.post('/', validate(registerWebhookSchema), registerWebhook);

/**
 * @route   GET /api/v1/webhooks
 * @desc    List the authenticated merchant's registered webhooks
 * @access  Merchant (enterprise) or admin
 */
router.get('/', listWebhooks);

/**
 * @route   GET /api/v1/webhooks/:id
 * @desc    Get a single webhook registration
 * @access  Merchant (enterprise) or admin
 */
router.get('/:id', getWebhook);

/**
 * @route   PATCH /api/v1/webhooks/:id
 * @desc    Update a webhook's URL, subscribed events, or active state
 * @access  Merchant (enterprise) or admin
 */
router.patch('/:id', validate(updateWebhookSchema), updateWebhook);

/**
 * @route   DELETE /api/v1/webhooks/:id
 * @desc    Remove a webhook registration
 * @access  Merchant (enterprise) or admin
 */
router.delete('/:id', deleteWebhook);

/**
 * @route   POST /api/v1/webhooks/:id/rotate-secret
 * @desc    Issue a new signing secret, invalidating the previous one
 * @access  Merchant (enterprise) or admin
 */
router.post('/:id/rotate-secret', rotateWebhookSecret);

export default router;
