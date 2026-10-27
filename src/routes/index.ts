import { Router } from 'express';
import authRoutes from './authRoutes';
import bulkDeliveryRoutes from './bulkDeliveryRoutes';
import deliveryChatRoutes from './deliveryChatRoutes';
import deliveryCrudRoutes from './delivery.routes';
import deliveryEtaRoutes from './deliveryRoutes';
import deliveryStatusRoutes from './deliveries';
import deliveryEventRoutes from './deliveryEventRoutes';
import adminRoutes from './adminRoutes';
import driverRoutes from './driverRoutes';
import fleetRoutes from './fleetRoutes';
import disputeRoutes from './disputeRoutes';
import eventLogRoutes from './eventLogRoutes';
import monitorRoutes from './monitorRoutes';
import metricsRoutes from './metricsRoutes';
import profileRoutes from './profileRoutes';
import notificationRoutes from './notificationRoutes';
import healthRoutes from './healthRoutes';
import userRoutes from './userRoutes';
import socketMetricsRoutes from './socketMetricsRoutes';
import stellarRoutes from './stellar.routes';
import transactionRoutes from './transactionRoutes';
import uploadRoutes from './uploadRoutes';
import webhookRoutes from './webhookRoutes';
import assignmentRoutes from './assignmentRoutes';
import proofOfDeliveryRoutes from './proofOfDeliveryRoutes';
import escrowRoutes from './escrow.routes';
import escrowIndexerRoutes from './escrowIndexer.routes';
import indexerRoutes from './indexer.routes';
import poolingRoutes from './poolingRoutes';
import chatRoutes from './chatRoutes';
import escrowAdminRoutes from './escrowAdminRoutes';
import onboardingRoutes from './onboardingRoutes';

const router = Router();

router.use('/v1/auth', authRoutes);
// Registered before the CRUD routes so the literal /bulk path is matched
// before any /:id parameter route can capture "bulk" as an identifier.
router.use('/v1/deliveries', bulkDeliveryRoutes);
router.use('/v1/deliveries', deliveryChatRoutes);
router.use('/v1/deliveries', deliveryCrudRoutes);
router.use('/v1/deliveries', deliveryEtaRoutes);
router.use('/v1/deliveries', deliveryStatusRoutes);
router.use('/v1/deliveries', deliveryEventRoutes);
router.use('/v1/deliveries', assignmentRoutes);
router.use('/v1/deliveries', proofOfDeliveryRoutes);
router.use('/v1/deliveries', chatRoutes);
router.use('/v1/admin/escrows', escrowAdminRoutes);
router.use('/v1/admin', adminRoutes);
router.use('/v1/drivers', driverRoutes);
router.use('/v1/fleets', fleetRoutes);
router.use('/v1/disputes', disputeRoutes);
router.use('/v1/eventlog', eventLogRoutes);
router.use('/v1/monitor', monitorRoutes);
router.use('/v1/metrics', metricsRoutes);
router.use('/v1/profile', profileRoutes);
router.use('/v1/notifications', notificationRoutes);
router.use('/v1/health', healthRoutes);
router.use('/v1/socket-metrics', socketMetricsRoutes);
router.use('/v1/users', userRoutes);
router.use('/v1/stellar', stellarRoutes);
router.use('/v1/transactions', transactionRoutes);
router.use('/v1/uploads', uploadRoutes);
router.use('/v1/webhooks', webhookRoutes);
router.use('/v1/onboarding', onboardingRoutes);
router.use('/v1/escrow', escrowRoutes);
router.use('/v1/indexer', escrowIndexerRoutes);
// Delivery-created contract events are posted by the indexer worker.
router.use('/v1/indexer', indexerRoutes);

router.use('/v1/pooling', poolingRoutes);

export default router;
