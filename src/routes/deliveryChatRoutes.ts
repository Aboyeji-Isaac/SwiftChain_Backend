import { Router } from 'express';
import authenticate from '../middleware/authenticate';
import {
  getDeliveryMessages,
  getUnreadCount,
  markMessagesAsRead,
} from '../controllers/deliveryChatController';

const router = Router();

router.use(authenticate);

/**
 * @route   GET /api/v1/deliveries/:id/messages
 * @desc    Paginated chat history for a delivery (participants only)
 * @access  Private (delivery participants: sender, recipient, driver, creator, admin)
 */
router.get('/:id/messages', getDeliveryMessages);

/**
 * @route   GET /api/v1/deliveries/:id/messages/unread
 * @desc    Get unread chat messages count for requesting user
 * @access  Private (delivery participants)
 */
router.get('/:id/messages/unread', getUnreadCount);
router.get('/:id/messages/unread-count', getUnreadCount);

/**
 * @route   PATCH /api/v1/deliveries/:id/messages/read
 * @desc    Mark unread messages in a delivery as read
 * @access  Private (delivery participants)
 */
router.patch('/:id/messages/read', markMessagesAsRead);
router.patch('/:id/messages/mark-read', markMessagesAsRead);

export default router;
