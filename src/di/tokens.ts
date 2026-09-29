/**
 * DI Container Token Definitions
 *
 * This file defines all named injection tokens used throughout the Awilix DI container.
 * Tokens are organized by category (Services, Models, Controllers, Config) for clarity.
 *
 * Token policy: exactly one canonical camelCase token per registration. Legacy
 * snake_case aliases (e.g. `delivery_service`) were removed so the container can
 * never resolve a duplicate or ambiguous binding for the same dependency.
 */

export const TOKENS = {
  // Services
  authService: 'authService',
  deliveryService: 'deliveryService',
  driverService: 'driverService',
  driverRatingService: 'driverRatingService',
  fleetService: 'fleetService',
  escrowService: 'escrowService',
  disputeService: 'disputeService',
  adminService: 'adminService',
  dashboardService: 'dashboardService',
  eventLogService: 'eventLogService',
  profilePictureService: 'profilePictureService',
  storageService: 'storageService',
  sorobanService: 'sorobanService',
  transactionService: 'transactionService',
  escrowMonitorService: 'escrowMonitorService',
  routingService: 'routingService',
  etaCacheService: 'etaCacheService',
  stellarService: 'stellarService',
  evidenceService: 'evidenceService',
  indexerService: 'indexerService',
  monitorService: 'monitorService',
  idempotencyService: 'idempotencyService',

  // Models (Mongoose schemas)
  userModel: 'userModel',
  deliveryModel: 'deliveryModel',
  driverProfileModel: 'driverProfileModel',
  fleetModel: 'fleetModel',
  escrowModel: 'escrowModel',
  disputeModel: 'disputeModel',
  eventLogModel: 'eventLogModel',
  evidenceModel: 'evidenceModel',
  fleetInvitationModel: 'fleetInvitationModel',
  locationUpdateModel: 'locationUpdateModel',
  chatMessageModel: 'chatMessageModel',
  indexerAlertModel: 'indexerAlertModel',
  indexerStatusModel: 'indexerStatusModel',
  idempotencyRecordModel: 'idempotencyRecordModel',

  // Config & Infrastructure
  logger: 'logger',
  redisClient: 'redisClient',
  env: 'env',

  // Controllers
  authController: 'authController',
  deliveryController: 'deliveryController',
  deliveryCrudController: 'deliveryCrudController',
  deliveryStatusController: 'deliveryStatusController',
  driverController: 'driverController',
  driverRatingController: 'driverRatingController',
  fleetController: 'fleetController',
  escrowController: 'escrowController',
  disputeController: 'disputeController',
  adminController: 'adminController',
  dashboardController: 'dashboardController',
  eventLogController: 'eventLogController',
  profileController: 'profileController',
  uploadController: 'uploadController',
  userController: 'userController',
  transactionController: 'transactionController',
  circuitBreakerController: 'circuitBreakerController',
  indexerController: 'indexerController',
  monitorController: 'monitorController',
  stellarController: 'stellarController',
} as const;
