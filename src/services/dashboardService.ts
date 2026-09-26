import {} from 'http-status-codes';
import Delivery, { DeliveryStatus } from '../models/Delivery';
import User from '../models/User';
import Escrow, { EscrowStatus } from '../models/Escrow';
import { LocationUpdate } from '../models/LocationUpdate';
import { UserRole, UserStatus } from '../interfaces/IUser';
import { getRedisClient } from '../config/redis';
import { sorobanService } from '../blockchain/soroban.service';
import logger from '../config/logger';

export interface ActiveDeliveriesMetrics {
  total: number;
  byStatus: {
    pending: number;
    funded: number;
    assigned: number;
    in_progress: number;
  };
}

export interface OnlineDriversMetrics {
  totalActiveDrivers: number;
  recentlyActiveDrivers: number;
}

export interface EscrowMetrics {
  totalVolume: number;
  lockedVolume: number;
  releasedVolume: number;
  refundedVolume: number;
  activeCount: number;
  totalCount: number;
}

export interface AdminDashboardMetrics {
  activeDeliveries: ActiveDeliveriesMetrics;
  onlineDrivers: OnlineDriversMetrics;
  escrow: EscrowMetrics;
  sorobanRpc?: {
    connected: boolean;
    latestLedger?: number;
    network?: string;
  };
  metadata: {
    timestamp: string;
    cached: boolean;
    cacheTtlSeconds: number;
  };
}

export interface GetDashboardMetricsOptions {
  forceRefresh?: boolean;
}

export class DashboardService {
  private readonly CACHE_KEY = 'admin:dashboard:metrics';

  private getCacheTtl(): number {
    const parsed = parseInt(process.env.ADMIN_DASHBOARD_CACHE_TTL_SECONDS ?? '60', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 60;
  }

  /**
   * Aggregate active deliveries, online drivers, and total escrow volume metrics.
   * Leverages Redis caching to reduce database load.
   */
  public async getAdminDashboardMetrics(
    options: GetDashboardMetricsOptions = {},
  ): Promise<AdminDashboardMetrics> {
    const ttlSeconds = this.getCacheTtl();
    const redis = getRedisClient();

    // 1. Try reading from cache unless forceRefresh is true
    if (!options.forceRefresh && redis) {
      try {
        const cachedRaw = await redis.get(this.CACHE_KEY);
        if (cachedRaw) {
          const cachedMetrics = JSON.parse(cachedRaw) as AdminDashboardMetrics;
          logger.debug('[DashboardService] Cache hit for admin metrics');
          return {
            ...cachedMetrics,
            metadata: {
              ...cachedMetrics.metadata,
              cached: true,
            },
          };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`[DashboardService] Cache read error: ${message}`);
      }
    }

    // 2. Aggregate metrics from database and blockchain in parallel
    const [activeDeliveries, onlineDrivers, escrow, sorobanInfo] = await Promise.all([
      this.getActiveDeliveriesMetrics(),
      this.getOnlineDriversMetrics(),
      this.getEscrowMetrics(),
      this.getSorobanInfo(),
    ]);

    const metrics: AdminDashboardMetrics = {
      activeDeliveries,
      onlineDrivers,
      escrow,
      sorobanRpc: sorobanInfo,
      metadata: {
        timestamp: new Date().toISOString(),
        cached: false,
        cacheTtlSeconds: ttlSeconds,
      },
    };

    // 3. Store aggregated metrics in cache
    if (redis) {
      try {
        await redis.set(this.CACHE_KEY, JSON.stringify(metrics), 'EX', ttlSeconds);
        logger.debug(`[DashboardService] Cached admin metrics with TTL=${ttlSeconds}s`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`[DashboardService] Cache write error: ${message}`);
      }
    }

    return metrics;
  }

  /**
   * Aggregate active delivery metrics from database.
   */
  private async getActiveDeliveriesMetrics(): Promise<ActiveDeliveriesMetrics> {
    const activeStatuses = [
      DeliveryStatus.PENDING,
      DeliveryStatus.FUNDED,
      DeliveryStatus.ASSIGNED,
      DeliveryStatus.IN_PROGRESS,
    ];

    const counts = await Delivery.aggregate<{ _id: string; count: number }>([
      {
        $match: {
          status: { $in: activeStatuses },
          isDeleted: { $ne: true },
        },
      },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
        },
      },
    ]);

    const byStatus = {
      pending: 0,
      funded: 0,
      assigned: 0,
      in_progress: 0,
    };

    let total = 0;
    for (const item of counts) {
      if (item._id in byStatus) {
        byStatus[item._id as keyof typeof byStatus] = item.count;
      }
      total += item.count;
    }

    return {
      total,
      byStatus,
    };
  }

  /**
   * Aggregate driver counts and recently online drivers from database.
   */
  private async getOnlineDriversMetrics(): Promise<OnlineDriversMetrics> {
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);

    const [totalActiveDrivers, recentlyActiveDriversList] = await Promise.all([
      User.countDocuments({
        role: UserRole.DRIVER,
        status: UserStatus.ACTIVE,
        isActive: true,
        isDeleted: { $ne: true },
      }),
      LocationUpdate.distinct('driverId', {
        capturedAt: { $gte: fifteenMinutesAgo },
      }),
    ]);

    return {
      totalActiveDrivers,
      recentlyActiveDrivers: Array.isArray(recentlyActiveDriversList)
        ? recentlyActiveDriversList.length
        : 0,
    };
  }

  /**
   * Aggregate total escrow volume and lock state metrics from database.
   */
  private async getEscrowMetrics(): Promise<EscrowMetrics> {
    const aggregationResult = await Escrow.aggregate<{
      _id: string;
      totalVolume: number;
      count: number;
    }>([
      {
        $group: {
          _id: '$status',
          totalVolume: { $sum: '$amount' },
          count: { $sum: 1 },
        },
      },
    ]);

    let totalVolume = 0;
    let lockedVolume = 0;
    let releasedVolume = 0;
    let refundedVolume = 0;
    let activeCount = 0;
    let totalCount = 0;

    for (const item of aggregationResult) {
      totalCount += item.count;
      totalVolume += item.totalVolume;

      if (item._id === EscrowStatus.LOCKED || item._id === EscrowStatus.DISPUTED) {
        lockedVolume += item.totalVolume;
        activeCount += item.count;
      } else if (item._id === EscrowStatus.RELEASED) {
        releasedVolume += item.totalVolume;
      } else if (item._id === EscrowStatus.REFUNDED) {
        refundedVolume += item.totalVolume;
      }
    }

    return {
      totalVolume: Math.round(totalVolume * 100) / 100,
      lockedVolume: Math.round(lockedVolume * 100) / 100,
      releasedVolume: Math.round(releasedVolume * 100) / 100,
      refundedVolume: Math.round(refundedVolume * 100) / 100,
      activeCount,
      totalCount,
    };
  }

  /**
   * Fetch Soroban connectivity status resiliently.
   */
  private async getSorobanInfo(): Promise<AdminDashboardMetrics['sorobanRpc']> {
    try {
      const conn = await sorobanService.checkConnectivity();
      if (conn.connected) {
        return {
          connected: true,
          latestLedger: conn.latestLedger,
          network: conn.network,
        };
      }
      return {
        connected: false,
        network: conn.network,
      };
    } catch {
      return {
        connected: false,
      };
    }
  }
}

export const dashboardService = new DashboardService();
export default dashboardService;
