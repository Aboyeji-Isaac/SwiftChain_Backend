import request from 'supertest';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import User from '../src/models/User';
import DriverProfile from '../src/models/DriverProfile';
import { UserRole, UserStatus } from '../src/interfaces/IUser';

jest.mock('../src/config/database', () => ({
  connectDatabase: jest.fn(),
}));

jest.mock('../src/config/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: MongoMemoryServer;

const SETUP_TIMEOUT = 120_000;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
}, SETUP_TIMEOUT);

afterEach(async () => {
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    await collections[key].deleteMany({});
  }
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
}, 15_000);

const JWT_SECRET = 'test-secret-key-16chars';

const signToken = (userId: string): string =>
  jwt.sign({ id: userId }, JWT_SECRET, { expiresIn: '1h' });

const createUser = async (
  overrides: Partial<{
    firstName: string;
    lastName: string;
    email: string;
    password: string;
    role: UserRole;
    status: UserStatus;
  }> = {},
): Promise<InstanceType<typeof User>> => {
  return User.create({
    firstName: overrides.firstName ?? 'Test',
    lastName: overrides.lastName ?? 'User',
    email: overrides.email ?? `user-${Date.now()}-${Math.random()}@example.com`,
    password: overrides.password ?? 'Password123!',
    role: overrides.role ?? UserRole.USER,
    status: overrides.status ?? UserStatus.ACTIVE,
  });
};

beforeEach(() => {
  process.env.JWT_SECRET = JWT_SECRET;
});

describe('PATCH /api/v1/drivers/me/vehicle', () => {
  describe('200 – successful updates', () => {
    it('creates a DriverProfile with vehicle details when none exists yet', async () => {
      const driver = await createUser({ role: UserRole.DRIVER });
      const token = signToken(driver._id.toString());

      const res = await request(app)
        .patch('/api/v1/drivers/me/vehicle')
        .set('Authorization', `Bearer ${token}`)
        .send({
          make: 'Toyota',
          model: 'Hiace',
          year: 2020,
          plateNumber: 'abc-123',
          capacityKg: 800,
        });

      expect(res.status).toBe(200);
      expect(res.body.data.profile.vehicleDetails.make).toBe('Toyota');
      // plateNumber is stored uppercase per the schema
      expect(res.body.data.profile.vehicleDetails.plateNumber).toBe('ABC-123');
    });

    it('persists the vehicle details to the database', async () => {
      const driver = await createUser({ role: UserRole.DRIVER });
      const token = signToken(driver._id.toString());

      await request(app)
        .patch('/api/v1/drivers/me/vehicle')
        .set('Authorization', `Bearer ${token}`)
        .send({ make: 'Honda', model: 'CR-V', plateNumber: 'XYZ-999' });

      const profile = await DriverProfile.findOne({ userId: driver._id });
      expect(profile?.vehicleDetails?.make).toBe('Honda');
      expect(profile?.vehicleDetails?.model).toBe('CR-V');
    });

    it('does not reset existing reputation stats when adding vehicle details', async () => {
      const driver = await createUser({ role: UserRole.DRIVER });
      const token = signToken(driver._id.toString());
      await DriverProfile.create({
        userId: driver._id,
        reputationPoints: 250,
        totalDeliveries: 10,
        completedDeliveries: 8,
      });

      await request(app)
        .patch('/api/v1/drivers/me/vehicle')
        .set('Authorization', `Bearer ${token}`)
        .send({ make: 'Ford', model: 'Transit', plateNumber: 'DEF-456' });

      const profile = await DriverProfile.findOne({ userId: driver._id });
      expect(profile?.reputationPoints).toBe(250);
      expect(profile?.totalDeliveries).toBe(10);
    });

    it('updates existing vehicle details on a second call', async () => {
      const driver = await createUser({ role: UserRole.DRIVER });
      const token = signToken(driver._id.toString());

      await request(app)
        .patch('/api/v1/drivers/me/vehicle')
        .set('Authorization', `Bearer ${token}`)
        .send({ make: 'Toyota', model: 'Hiace', plateNumber: 'OLD-001' });

      const res = await request(app)
        .patch('/api/v1/drivers/me/vehicle')
        .set('Authorization', `Bearer ${token}`)
        .send({ make: 'Toyota', model: 'Hiace', plateNumber: 'NEW-002' });

      expect(res.body.data.profile.vehicleDetails.plateNumber).toBe('NEW-002');

      const profiles = await DriverProfile.find({ userId: driver._id });
      expect(profiles).toHaveLength(1);
    });
  });

  describe('400 – validation errors', () => {
    it('returns 400 when make is missing', async () => {
      const driver = await createUser({ role: UserRole.DRIVER });
      const token = signToken(driver._id.toString());

      const res = await request(app)
        .patch('/api/v1/drivers/me/vehicle')
        .set('Authorization', `Bearer ${token}`)
        .send({ model: 'Hiace', plateNumber: 'ABC-123' });

      expect(res.status).toBe(400);
    });

    it('returns 400 when model is missing', async () => {
      const driver = await createUser({ role: UserRole.DRIVER });
      const token = signToken(driver._id.toString());

      const res = await request(app)
        .patch('/api/v1/drivers/me/vehicle')
        .set('Authorization', `Bearer ${token}`)
        .send({ make: 'Toyota', plateNumber: 'ABC-123' });

      expect(res.status).toBe(400);
    });

    it('returns 400 when plateNumber is missing', async () => {
      const driver = await createUser({ role: UserRole.DRIVER });
      const token = signToken(driver._id.toString());

      const res = await request(app)
        .patch('/api/v1/drivers/me/vehicle')
        .set('Authorization', `Bearer ${token}`)
        .send({ make: 'Toyota', model: 'Hiace' });

      expect(res.status).toBe(400);
    });

    it('returns 400 when year is not a number', async () => {
      const driver = await createUser({ role: UserRole.DRIVER });
      const token = signToken(driver._id.toString());

      const res = await request(app)
        .patch('/api/v1/drivers/me/vehicle')
        .set('Authorization', `Bearer ${token}`)
        .send({ make: 'Toyota', model: 'Hiace', plateNumber: 'ABC-123', year: 'old' });

      expect(res.status).toBe(400);
    });
  });

  describe('401 – authentication errors', () => {
    it('returns 401 when no Authorization header is provided', async () => {
      const res = await request(app)
        .patch('/api/v1/drivers/me/vehicle')
        .send({ make: 'Toyota', model: 'Hiace', plateNumber: 'ABC-123' });

      expect(res.status).toBe(401);
    });
  });

  describe('403 – authorisation errors', () => {
    it('returns 403 when a non-driver tries to set vehicle details', async () => {
      const user = await createUser({ role: UserRole.USER });
      const token = signToken(user._id.toString());

      const res = await request(app)
        .patch('/api/v1/drivers/me/vehicle')
        .set('Authorization', `Bearer ${token}`)
        .send({ make: 'Toyota', model: 'Hiace', plateNumber: 'ABC-123' });

      expect(res.status).toBe(403);
    });
  });
});
