import { Router } from 'express';
import authenticate from '../middleware/authenticate';
import {
  getDeliveryMessages,
  getUnreadCount,
  markMessagesAsRead,
} from '../controllers/deliveryChatController';

const router = Router();

/**
 * @route   GET /api/v1/deliveries/:id/messages
 * @desc    Paginated chat history for a delivery (participants only)
 * @access  Private (delivery participants: sender, recipient, driver, creator, admin)
 */
router.get('/:id/messages', authenticate, getDeliveryMessages);

/**
 * @route   GET /api/v1/deliveries/:id/messages/unread
 * @desc    Get unread chat messages count for requesting user
 * @access  Private (delivery participants)
 */
router.get('/:id/messages/unread', authenticate, getUnreadCount);
router.get('/:id/messages/unread-count', authenticate, getUnreadCount);

/**
 * @route   PATCH /api/v1/deliveries/:id/messages/read
 * @desc    Mark unread messages in a delivery as read
 * @access  Private (delivery participants)
 */
router.patch('/:id/messages/read', authenticate, markMessagesAsRead);
router.patch('/:id/messages/mark-read', authenticate, markMessagesAsRead);

export default router;
