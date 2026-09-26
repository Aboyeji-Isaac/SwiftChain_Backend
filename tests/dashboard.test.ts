import { StatusCodes } from 'http-status-codes';
import { dashboardService } from '../src/services/dashboardService';
import { dashboardController } from '../src/controllers/dashboardController';
import Delivery, { DeliveryStatus } from '../src/models/Delivery';
import User from '../src/models/User';
import Escrow, { EscrowStatus } from '../src/models/Escrow';
import { LocationUpdate } from '../src/models/LocationUpdate';
import { UserRole } from '../src/interfaces/IUser';
import { getRedisClient } from '../src/config/redis';

jest.mock('../src/models/Delivery');
jest.mock('../src/models/User');
jest.mock('../src/models/Escrow');
jest.mock('../src/models/LocationUpdate');
jest.mock('../src/config/redis', () => ({
  getRedisClient: jest.fn(),
  redisClient: null,
}));
jest.mock('../src/blockchain/soroban.service', () => ({
  sorobanService: {
    checkConnectivity: jest.fn().mockResolvedValue({
      connected: true,
      network: 'testnet',
      latestLedger: 123456,
    }),
  },
}));

describe('Admin Dashboard Metrics API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getRedisClient as jest.Mock).mockReturnValue(null);
  });

  describe('DashboardService', () => {
    it('should aggregate active deliveries, online drivers, and total escrow volume', async () => {
      (Delivery.aggregate as jest.Mock).mockResolvedValue([
        { _id: DeliveryStatus.PENDING, count: 2 },
        { _id: DeliveryStatus.IN_PROGRESS, count: 3 },
      ]);

      (User.countDocuments as jest.Mock).mockResolvedValue(10);
      (LocationUpdate.distinct as jest.Mock).mockResolvedValue(['driver1', 'driver2']);

      (Escrow.aggregate as jest.Mock).mockResolvedValue([
        { _id: EscrowStatus.LOCKED, totalVolume: 1500, count: 3 },
        { _id: EscrowStatus.RELEASED, totalVolume: 500, count: 2 },
      ]);

      const metrics = await dashboardService.getAdminDashboardMetrics();

      expect(metrics.activeDeliveries.total).toBe(5);
      expect(metrics.activeDeliveries.byStatus.pending).toBe(2);
      expect(metrics.activeDeliveries.byStatus.in_progress).toBe(3);
      expect(metrics.activeDeliveries.byStatus.funded).toBe(0);

      expect(metrics.onlineDrivers.totalActiveDrivers).toBe(10);
      expect(metrics.onlineDrivers.recentlyActiveDrivers).toBe(2);

      expect(metrics.escrow.totalVolume).toBe(2000);
      expect(metrics.escrow.lockedVolume).toBe(1500);
      expect(metrics.escrow.releasedVolume).toBe(500);
      expect(metrics.escrow.activeCount).toBe(3);
      expect(metrics.escrow.totalCount).toBe(5);

      expect(metrics.sorobanRpc?.connected).toBe(true);
      expect(metrics.metadata.cached).toBe(false);
    });

    it('should return cached metrics if present in Redis and not forceRefreshed', async () => {
      const mockCachedMetrics = {
        activeDeliveries: {
          total: 4,
          byStatus: { pending: 4, funded: 0, assigned: 0, in_progress: 0 },
        },
        onlineDrivers: { totalActiveDrivers: 5, recentlyActiveDrivers: 1 },
        escrow: {
          totalVolume: 100,
          lockedVolume: 100,
          releasedVolume: 0,
          refundedVolume: 0,
          activeCount: 1,
          totalCount: 1,
        },
        metadata: { timestamp: new Date().toISOString(), cached: true, cacheTtlSeconds: 60 },
      };

      const mockRedis = {
        get: jest.fn().mockResolvedValue(JSON.stringify(mockCachedMetrics)),
        set: jest.fn(),
      };
      (getRedisClient as jest.Mock).mockReturnValue(mockRedis);

      const metrics = await dashboardService.getAdminDashboardMetrics();

      expect(mockRedis.get).toHaveBeenCalledWith('admin:dashboard:metrics');
      expect(metrics.metadata.cached).toBe(true);
      expect(Delivery.aggregate).not.toHaveBeenCalled();
    });

    it('should bypass cache when forceRefresh is true', async () => {
      (Delivery.aggregate as jest.Mock).mockResolvedValue([
        { _id: DeliveryStatus.PENDING, count: 1 },
      ]);
      (User.countDocuments as jest.Mock).mockResolvedValue(2);
      (LocationUpdate.distinct as jest.Mock).mockResolvedValue([]);
      (Escrow.aggregate as jest.Mock).mockResolvedValue([]);

      const mockRedis = {
        get: jest.fn(),
        set: jest.fn().mockResolvedValue('OK'),
      };
      (getRedisClient as jest.Mock).mockReturnValue(mockRedis);

      const metrics = await dashboardService.getAdminDashboardMetrics({ forceRefresh: true });

      expect(mockRedis.get).not.toHaveBeenCalled();
      expect(Delivery.aggregate).toHaveBeenCalled();
      expect(mockRedis.set).toHaveBeenCalled();
      expect(metrics.metadata.cached).toBe(false);
    });
  });

  describe('DashboardController Unit Handler', () => {
    it('should throw UNAUTHORIZED if req.user is missing', async () => {
      const req = { query: {} } as any;
      const res = {} as any;
      const next = jest.fn();

      await dashboardController.getDashboardMetrics(req, res, next);

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: StatusCodes.UNAUTHORIZED,
          message: 'Authentication required.',
        }),
      );
    });

    it('should send success response with metrics when user is authenticated', async () => {
      const mockMetrics = {
        activeDeliveries: {
          total: 2,
          byStatus: { pending: 1, funded: 0, assigned: 0, in_progress: 1 },
        },
        onlineDrivers: { totalActiveDrivers: 3, recentlyActiveDrivers: 1 },
        escrow: {
          totalVolume: 300,
          lockedVolume: 300,
          releasedVolume: 0,
          refundedVolume: 0,
          activeCount: 1,
          totalCount: 1,
        },
        metadata: { timestamp: new Date().toISOString(), cached: false, cacheTtlSeconds: 60 },
      };

      jest
        .spyOn(dashboardService, 'getAdminDashboardMetrics')
        .mockResolvedValue(mockMetrics as any);

      const req = {
        user: { _id: 'admin123', role: UserRole.ADMIN },
        query: { refresh: 'true' },
      } as any;

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      } as any;
      const next = jest.fn();

      await dashboardController.getDashboardMetrics(req, res, next);

      expect(dashboardService.getAdminDashboardMetrics).toHaveBeenCalledWith({
        forceRefresh: true,
      });
      expect(res.status).toHaveBeenCalledWith(StatusCodes.OK);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: mockMetrics,
        }),
      );
    });
  });
});
