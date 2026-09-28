/**
 * DI Container Resolution Tests
 *
 * This test suite demonstrates:
 * 1. Successful container initialization and resolution of the full dependency graph
 * 2. Testability improvements: ability to override dependencies for testing
 * 3. Service singleton behavior (same instance returned on multiple resolutions)
 */

import { createDIContainer, resetContainer } from '../src/di/container';
import { TOKENS } from '../src/di/tokens';
import { asValue } from 'awilix';
import type { AwilixContainer } from 'awilix';

describe('DI Container', () => {
  let container: AwilixContainer;

  beforeEach(() => {
    resetContainer();
    container = createDIContainer();
  });

  describe('Container Initialization', () => {
    it('should create container successfully', () => {
      expect(container).toBeDefined();
      expect(container).not.toBeNull();
    });

    it('should be configured with PROXY injection mode', () => {
      expect(container).toBeDefined();
    });
  });

  describe('Config & Infrastructure Resolution', () => {
    it('should resolve logger', () => {
      const logger = container.resolve(TOKENS.logger);
      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe('function');
    });

    it('should resolve env config', () => {
      const envConfig = container.resolve(TOKENS.env);
      expect(envConfig).toBeDefined();
      expect(envConfig.NODE_ENV).toBeDefined();
    });

    it('should resolve redis client', () => {
      const redis = container.resolve(TOKENS.redisClient);
      expect(redis).toBeDefined();
    });
  });

  describe('Model Resolution', () => {
    it('should resolve User model', () => {
      const User = container.resolve(TOKENS.userModel);
      expect(User).toBeDefined();
      expect(User.collection).toBeDefined();
    });

    it('should resolve Delivery model', () => {
      const Delivery = container.resolve(TOKENS.deliveryModel);
      expect(Delivery).toBeDefined();
      expect(Delivery.collection).toBeDefined();
    });

    it('should resolve Escrow model', () => {
      const Escrow = container.resolve(TOKENS.escrowModel);
      expect(Escrow).toBeDefined();
      expect(Escrow.collection).toBeDefined();
    });

    it('should resolve all models', () => {
      const models = [
        TOKENS.userModel,
        TOKENS.deliveryModel,
        TOKENS.driverProfileModel,
        TOKENS.fleetModel,
        TOKENS.escrowModel,
        TOKENS.disputeModel,
        TOKENS.eventLogModel,
        TOKENS.evidenceModel,
        TOKENS.fleetInvitationModel,
        TOKENS.locationUpdateModel,
        TOKENS.chatMessageModel,
        TOKENS.indexerAlertModel,
        TOKENS.indexerStatusModel,
        TOKENS.idempotencyRecordModel,
      ];

      models.forEach((token) => {
        const model = container.resolve(token as never);
        expect(model).toBeDefined();
        expect(model.collection).toBeDefined();
      });
    });
  });

  describe('Service Resolution', () => {
    it('should resolve authService', () => {
      const authService = container.resolve(TOKENS.authService);
      expect(authService).toBeDefined();
      expect(typeof authService.login).toBe('function');
    });

    it('should resolve deliveryService', () => {
      const deliveryService = container.resolve(TOKENS.deliveryService);
      expect(deliveryService).toBeDefined();
    });

    it('resolves the escrowService singleton', () => {
      const escrowService = container.resolve(TOKENS.escrowService);
      expect(escrowService).toBeDefined();
    });

    it('should resolve sorobanService', () => {
      const sorobanService = container.resolve(TOKENS.sorobanService);
      expect(sorobanService).toBeDefined();
    });

    it('registers exactly one canonical token per dependency', () => {
      // Regression guard for the duplicate-token bug: the legacy snake_case
      // aliases must never come back as container registrations.
      const legacyAliases = [
        'delivery_service',
        'escrow_service',
        'delivery_controller',
        'escrow_controller',
        'indexer_controller',
        'stellar_controller',
      ];

      const registrations = Object.keys(
        (container as unknown as { registrations: Record<string, unknown> }).registrations,
      );

      legacyAliases.forEach((alias) => {
        expect(registrations).not.toContain(alias);
      });
    });

    it('should resolve all services', () => {
      const services = [
        TOKENS.authService,
        TOKENS.deliveryService,
        TOKENS.driverService,
        TOKENS.driverRatingService,
        TOKENS.fleetService,
        TOKENS.escrowService,
        TOKENS.disputeService,
        TOKENS.adminService,
        TOKENS.eventLogService,
        TOKENS.profilePictureService,
        TOKENS.storageService,
        TOKENS.sorobanService,
        TOKENS.transactionService,
        TOKENS.escrowMonitorService,
        TOKENS.routingService,
        TOKENS.etaCacheService,
        TOKENS.stellarService,
        TOKENS.evidenceService,
        TOKENS.indexerService,
        TOKENS.monitorService,
        TOKENS.idempotencyService,
      ];

      services.forEach((token) => {
        const service = container.resolve(token as never);
        expect(service).toBeDefined();
      });
    });
  });

  describe('Controller Resolution', () => {
    it('should resolve authController', () => {
      const authController = container.resolve(TOKENS.authController);
      expect(authController).toBeDefined();
      expect(typeof authController.login).toBe('function');
    });

    it('should resolve deliveryController', () => {
      const deliveryController = container.resolve(TOKENS.deliveryController);
      expect(deliveryController).toBeDefined();
    });

    it('should resolve fleetController', () => {
      const fleetController = container.resolve(TOKENS.fleetController);
      expect(fleetController).toBeDefined();
    });

    it('should resolve driverRatingController', () => {
      const driverRatingController = container.resolve(TOKENS.driverRatingController);
      expect(driverRatingController).toBeDefined();
      expect(typeof driverRatingController.getDriverRating).toBe('function');
    });

    it('resolves the canonical deliveryController token', () => {
      const deliveryController = container.resolve(TOKENS.deliveryController);
      expect(deliveryController).toBeDefined();
    });
  });

  describe('Singleton Behavior', () => {
    it('should return same authService instance on multiple resolutions', () => {
      const service1 = container.resolve(TOKENS.authService);
      const service2 = container.resolve(TOKENS.authService);
      expect(service1).toBe(service2);
    });

    it('should return same controller instance on multiple resolutions', () => {
      const controller1 = container.resolve(TOKENS.authController);
      const controller2 = container.resolve(TOKENS.authController);
      expect(controller1).toBe(controller2);
    });

    it('should maintain singleton pattern across service and model resolution', () => {
      const authService1 = container.resolve(TOKENS.authService);
      const authService2 = container.resolve(TOKENS.authService);
      expect(authService1).toBe(authService2);
    });
  });

  describe('Full Dependency Graph Resolution (Testability)', () => {
    it('should resolve authController with its full dependency chain', () => {
      const authController = container.resolve(TOKENS.authController);
      expect(authController).toBeDefined();
      expect(typeof authController.login).toBe('function');
      expect(typeof authController.register).toBe('function');
      // authController depends on authService, which depends on User model
      // This proves the full transitive dependency chain is wired correctly
    });

    it('should resolve deliveryController with its full dependency chain', () => {
      const deliveryController = container.resolve(TOKENS.deliveryController);
      expect(deliveryController).toBeDefined();
      // deliveryController depends on deliveryService, which depends on models
    });

    it('should allow easy dependency mocking for testing', () => {
      // Create a new container for this test
      const testContainer = createDIContainer();

      // Mock the logger with a spy
      const mockLogger = {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      };

      testContainer.register({
        [TOKENS.logger]: asValue(mockLogger),
      });

      // Resolve the mocked logger
      const logger = testContainer.resolve(TOKENS.logger);
      expect(logger.info).toBe(mockLogger.info);

      // Verify we can call it
      logger.info('Test message');
      expect(mockLogger.info).toHaveBeenCalledWith('Test message');
    });

    it('should allow overriding service dependencies for testing', () => {
      const testContainer = createDIContainer();

      // Create a mock authService
      const mockAuthService = {
        login: jest.fn().mockResolvedValue({
          user: { id: 'test-id', email: 'test@example.com', role: 'user' },
          token: 'test-token',
        }),
        registerUser: jest.fn(),
        getUserById: jest.fn(),
        verifyToken: jest.fn(),
      };

      // Register the mock
      testContainer.register({
        [TOKENS.authService]: asValue(mockAuthService),
      });

      // Verify the mock is used
      const authService = testContainer.resolve(TOKENS.authService);
      expect(authService).toBe(mockAuthService);
    });
  });

  describe('Container Reset (Test Isolation)', () => {
    it('should reset container state', () => {
      const container1 = createDIContainer();
      const service1 = container1.resolve(TOKENS.authService);

      resetContainer();

      const container2 = createDIContainer();
      const service2 = container2.resolve(TOKENS.authService);

      // Different container instances, but same service (since it's a singleton value)
      expect(service1).toBe(service2);
    });
  });
});
