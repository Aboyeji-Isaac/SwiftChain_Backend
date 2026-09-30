import { Router } from 'express';
import eventLogController from '../controllers/eventLogController';
import authenticate from '../middleware/authenticate';
import requireRole from '../middleware/requireRole';
import { UserRole } from '../interfaces/IUser';
import { buildQueryOptions } from '../middlewares/queryMiddleware';

const router = Router();

// All routes require authentication
router.use(authenticate);

// Get last processed ledger sequence
router.get('/last-processed', eventLogController.getLastProcessedLedger.bind(eventLogController));

// Get unprocessed events (paginated)
router.get(
  '/unprocessed',
  requireRole(UserRole.ADMIN, UserRole.ENTERPRISE),
  buildQueryOptions({
    sortableFields: ['createdAt', 'ledgerSequence'],
    filterableFields: {},
    defaultSort: { createdAt: 1 },
    defaultLimit: 20,
  }),
  eventLogController.getUnprocessedEvents.bind(eventLogController),
);

// Get events by ledger range
router.get(
  '/range',
  requireRole(UserRole.ADMIN, UserRole.ENTERPRISE),
  eventLogController.getEventsByLedgerRange.bind(eventLogController),
);

// Get event by transaction hash
router.get(
  '/transaction/:hash',
  eventLogController.getEventByTransactionHash.bind(eventLogController),
);

export default router;
