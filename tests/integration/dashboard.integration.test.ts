import request from 'supertest';
import jwt from 'jsonwebtoken';
import { StatusCodes } from 'http-status-codes';
import app from '../../src/app';
import User from '../../src/models/User';
import Delivery, { DeliveryStatus } from '../../src/models/Delivery';
import Escrow, { EscrowStatus } from '../../src/models/Escrow';
import { LocationUpdate } from '../../src/models/LocationUpdate';
import { UserRole, UserStatus } from '../../src/interfaces/IUser';
import env from '../../src/config/env';

jest.mock('../../src/models/User');
jest.mock('../../src/models/Delivery');
jest.mock('../../src/models/Escrow');
jest.mock('../../src/models/LocationUpdate');
jest.mock('../../src/config/redis', () => ({
  getRedisClient: jest.fn().mockReturnValue(null),
  redisClient: null,
}));
jest.mock('../../src/blockchain/soroban.service', () => ({
  sorobanService: {
    checkConnectivity: jest.fn().mockResolvedValue({
      connected: true,
      network: 'testnet',
      latestLedger: 1000,
    }),
  },
}));

describe('Admin Dashboard Endpoint GET /api/v1/admin/dashboard', () => {
  const adminId = '507f1f77bcf86cd799439011';
  const userId = '507f1f77bcf86cd799439022';

  let adminToken: string;
  let userToken: string;

  beforeAll(() => {
    adminToken = jwt.sign({ userId: adminId, role: UserRole.ADMIN }, env.JWT_SECRET, {
      expiresIn: '1h',
    });

    userToken = jwt.sign({ userId: userId, role: UserRole.USER }, env.JWT_SECRET, {
      expiresIn: '1h',
    });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (LocationUpdate.distinct as jest.Mock).mockResolvedValue(['driver1']);
  });

  it('should return 401 Unauthorized when Bearer token is missing', async () => {
    const res = await request(app).get('/api/v1/admin/dashboard');
    expect(res.status).toBe(StatusCodes.UNAUTHORIZED);
  });

  it('should return 403 Forbidden when authenticated user is not an admin', async () => {
    (User.findById as jest.Mock).mockReturnValue({
      select: jest.fn().mockResolvedValue({
        _id: userId,
        role: UserRole.USER,
        status: UserStatus.ACTIVE,
        isActive: true,
      }),
    });

    const res = await request(app)
      .get('/api/v1/admin/dashboard')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(StatusCodes.FORBIDDEN);
  });

  it('should return 200 OK with aggregated metrics for admin user', async () => {
    (User.findById as jest.Mock).mockReturnValue({
      select: jest.fn().mockResolvedValue({
        _id: adminId,
        role: UserRole.ADMIN,
        status: UserStatus.ACTIVE,
        isActive: true,
      }),
    });

    (Delivery.aggregate as jest.Mock).mockResolvedValue([
      { _id: DeliveryStatus.PENDING, count: 5 },
      { _id: DeliveryStatus.IN_PROGRESS, count: 2 },
    ]);

    (User.countDocuments as jest.Mock).mockResolvedValue(15);

    (Escrow.aggregate as jest.Mock).mockResolvedValue([
      { _id: EscrowStatus.LOCKED, totalVolume: 2500, count: 4 },
    ]);

    const res = await request(app)
      .get('/api/v1/admin/dashboard')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(StatusCodes.OK);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('activeDeliveries');
    expect(res.body.data.activeDeliveries.total).toBe(7);
    expect(res.body.data).toHaveProperty('onlineDrivers');
    expect(res.body.data.onlineDrivers.totalActiveDrivers).toBe(15);
    expect(res.body.data.onlineDrivers.recentlyActiveDrivers).toBe(1);
    expect(res.body.data).toHaveProperty('escrow');
    expect(res.body.data.escrow.totalVolume).toBe(2500);
  });
});
