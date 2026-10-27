/**
 * Awilix Dependency Injection Container
 *
 * This module sets up and configures the Awilix DI container for the SwiftChain backend.
 * All dependencies (services, models, controllers, config) are registered here with appropriate
 * lifetimes (singleton vs transient).
 *
 * Lifetime Strategy:
 * - SINGLETON: Services (stateless), Models (Mongoose schemas), Config, Logger, Redis
 * - SINGLETON: Controllers (already instantiated singletons in this codebase)
 *
 * Architecture:
 * Controllers → Services → Models (Mongoose)
 *
 * Token policy: exactly one canonical token per registration (see ./tokens.ts).
 * Legacy snake_case aliases are intentionally NOT registered so consumers can
 * never be wired to a duplicate or stale binding.
 */

import { createContainer, InjectionMode, asValue } from 'awilix';
import type { AwilixContainer } from 'awilix';

// ─── Config & Infrastructure ───────────────────────────────────────────────────
import logger from '../config/logger';
import env from '../config/env';
import { redisClient } from '../config/redis';

// ─── Models (Mongoose Schemas) ─────────────────────────────────────────────────
import User from '../models/User';
import Delivery from '../models/Delivery';
import DriverProfile from '../models/DriverProfile';
import Fleet from '../models/Fleet';
import Escrow from '../models/Escrow';
import Dispute from '../models/Dispute';
import EventLog from '../models/EventLog';
import { Evidence } from '../models/Evidence';
import FleetInvitation from '../models/FleetInvitation';
import { LocationUpdate } from '../models/LocationUpdate';
import ChatMessage from '../models/ChatMessage';
import { IndexerAlert } from '../models/IndexerAlert';
import { IndexerStatus } from '../models/IndexerStatus';
import IdempotencyRecord from '../models/IdempotencyRecord';

// ─── Services ──────────────────────────────────────────────────────────────────
import authService from '../services/authService';
import { deliveryService } from '../services/delivery.service';
import { driverService } from '../services/driverService';
import { driverRatingService } from '../services/driverRatingService';
import * as fleetService from '../services/fleetService';
import { escrowService } from '../services/escrow.service';
import * as disputeService from '../services/disputeService';
import * as adminService from '../services/adminService';
import dashboardService from '../services/dashboardService';
import eventLogService from '../services/eventLogService';
import { profilePictureService } from '../services/profilePicture.service';
import * as storageService from '../services/storage.service';
import { sorobanService } from '../blockchain/soroban.service';
import { transactionService } from '../services/transactionService';
import escrowMonitorService from '../services/escrowMonitorService';
import { routingService } from '../services/routingService';
import { etaCacheService } from '../services/etaCacheService';
import { stellarService } from '../services/stellarService';
import * as evidenceService from '../services/evidenceService';
import { indexerService } from '../services/indexerService';
import * as monitorService from '../services/monitorService';
import { idempotencyService } from '../services/idempotency.service';
import { SdkSorobanRpcClient } from '../services/providers/adapters';
import { getStorageDriver } from '../services/storage.service';

// ─── Controllers ───────────────────────────────────────────────────────────
// Import controller singleton instances (already instantiated in their modules)
import authController from '../controllers/authController';
import { deliveryController } from '../controllers/delivery.controller';
import * as deliveryStatusController from '../controllers/deliveryStatusController';
import { driverController } from '../controllers/driverController';
import { driverRatingController } from '../controllers/driverRatingController';
import * as fleetController from '../controllers/fleetController';
import { escrowController } from '../controllers/escrow.controller';
import * as disputeController from '../controllers/disputeController';
import * as adminController from '../controllers/adminController';
import dashboardController from '../controllers/dashboardController';
import eventLogController from '../controllers/eventLogController';
import * as profileController from '../controllers/profileController';
import * as uploadController from '../controllers/uploadController';
import userController from '../controllers/userController';
import { transactionController } from '../controllers/transactionController';
import { circuitBreakerController } from '../controllers/circuitBreakerController';
import { indexerController } from '../controllers/indexerController';
import * as monitorController from '../controllers/monitorController';
import { stellarController } from '../controllers/stellar.controller';

import { TOKENS } from './tokens';

/**
 * Create and configure the Awilix DI container.
 * This function is called once at application startup.
 */
export function createDIContainer(): AwilixContainer {
  const container = createContainer({
    injectionMode: InjectionMode.PROXY,
  });

  // ─── Register Config & Infrastructure (Singleton) ──────────────────────
  container.register({
    [TOKENS.logger]: asValue(logger),
    [TOKENS.env]: asValue(env),
    [TOKENS.redisClient]: asValue(redisClient),
  });

  // ─── Register Models (Singleton) ───────────────────────────────────────
  container.register({
    [TOKENS.userModel]: asValue(User),
    [TOKENS.deliveryModel]: asValue(Delivery),
    [TOKENS.driverProfileModel]: asValue(DriverProfile),
    [TOKENS.fleetModel]: asValue(Fleet),
    [TOKENS.escrowModel]: asValue(Escrow),
    [TOKENS.disputeModel]: asValue(Dispute),
    [TOKENS.eventLogModel]: asValue(EventLog),
    [TOKENS.evidenceModel]: asValue(Evidence),
    [TOKENS.fleetInvitationModel]: asValue(FleetInvitation),
    [TOKENS.locationUpdateModel]: asValue(LocationUpdate),
    [TOKENS.chatMessageModel]: asValue(ChatMessage),
    [TOKENS.indexerAlertModel]: asValue(IndexerAlert),
    [TOKENS.indexerStatusModel]: asValue(IndexerStatus),
    [TOKENS.idempotencyRecordModel]: asValue(IdempotencyRecord),
  });

  // ─── Register Services (Singleton) ─────────────────────────────────────
  // Most services are already instantiated singletons exported from their modules,
  // so we register them as values rather than classes. One canonical token each.
  container.register({
    [TOKENS.authService]: asValue(authService),
    [TOKENS.deliveryService]: asValue(deliveryService),
    [TOKENS.driverService]: asValue(driverService),
    [TOKENS.driverRatingService]: asValue(driverRatingService),
    [TOKENS.fleetService]: asValue(fleetService),
    [TOKENS.escrowService]: asValue(escrowService),
    [TOKENS.disputeService]: asValue(disputeService),
    [TOKENS.adminService]: asValue(adminService),
    [TOKENS.dashboardService]: asValue(dashboardService),
    [TOKENS.eventLogService]: asValue(eventLogService),
    [TOKENS.profilePictureService]: asValue(profilePictureService),
    [TOKENS.storageService]: asValue(storageService),
    [TOKENS.sorobanService]: asValue(sorobanService),
    [TOKENS.transactionService]: asValue(transactionService),
    [TOKENS.escrowMonitorService]: asValue(escrowMonitorService),
    [TOKENS.routingService]: asValue(routingService),
    [TOKENS.etaCacheService]: asValue(etaCacheService),
    [TOKENS.stellarService]: asValue(stellarService),
    [TOKENS.evidenceService]: asValue(evidenceService),
    [TOKENS.indexerService]: asValue(indexerService),
    [TOKENS.monitorService]: asValue(monitorService),
    [TOKENS.idempotencyService]: asValue(idempotencyService),

    // ─── External SDK clients behind provider interfaces (issue #222) ─────
    [TOKENS.routingProvider]: asValue(routingService),
    [TOKENS.sorobanRpcClient]: asValue(new SdkSorobanRpcClient()),
    [TOKENS.imagesStorage]: asValue(getStorageDriver()),
  });

  // ─── Register Controllers (Singleton) ──────────────────────────────────
  // Controllers in this codebase are already instantiated as singletons.
  // They are registered in the container for:
  // 1. Centralized dependency resolution
  // 2. Easier testing and mocking
  // 3. Future refactoring to support per-request instantiation if needed
  container.register({
    [TOKENS.authController]: asValue(authController),
    [TOKENS.deliveryController]: asValue(deliveryController),
    [TOKENS.deliveryStatusController]: asValue(deliveryStatusController),
    [TOKENS.driverController]: asValue(driverController),
    [TOKENS.driverRatingController]: asValue(driverRatingController),
    [TOKENS.fleetController]: asValue(fleetController),
    [TOKENS.escrowController]: asValue(escrowController),
    [TOKENS.disputeController]: asValue(disputeController),
    [TOKENS.adminController]: asValue(adminController),
    [TOKENS.dashboardController]: asValue(dashboardController),
    [TOKENS.eventLogController]: asValue(eventLogController),
    [TOKENS.profileController]: asValue(profileController),
    [TOKENS.uploadController]: asValue(uploadController),
    [TOKENS.userController]: asValue(userController),
    [TOKENS.transactionController]: asValue(transactionController),
    [TOKENS.circuitBreakerController]: asValue(circuitBreakerController),
    [TOKENS.indexerController]: asValue(indexerController),
    [TOKENS.monitorController]: asValue(monitorController),
    [TOKENS.stellarController]: asValue(stellarController),
  });

  return container;
}

/**
 * Global container instance.
 * Instantiated once at application startup and reused throughout the lifecycle.
 */
let container: AwilixContainer | null = null;

/**
 * Get the DI container instance. Creates it if it doesn't exist.
 */
export function getContainer(): AwilixContainer {
  if (!container) {
    container = createDIContainer();
  }
  return container;
}

/**
 * Reset the container (useful for testing).
 */
export function resetContainer(): void {
  container = null;
}

export default getContainer();
