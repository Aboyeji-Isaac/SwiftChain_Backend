import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Express } from 'express';

import User from '../src/models/User';
import DriverProfile from '../src/models/DriverProfile';
import Delivery from '../src/models/Delivery';
import { IUser } from '../src/interfaces/IUser';

jest.mock('../src/config/database', () => ({
  connectDatabase: jest.fn(),
}));

jest.mock('../src/config/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

let app: Express;
let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  const mod = await import('../src/app');
  app = mod.default;
});

afterEach(async () => {
  await mongoose.connection.collection('users').deleteMany({});
  await mongoose.connection.collection('driverprofiles').deleteMany({});
  await mongoose.connection.collection('deliveries').deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

const registerAndLogin = async (email: string, password: string, role = 'user') => {
  const registerRes = await request(app).post('/api/v1/auth/register').send({
    firstName: 'Test',
    lastName: 'User',
    email,
    password,
  });

  expect(registerRes.status).toBe(201);

  // Promote to admin if needed for protected routes
  if (role === 'admin') {
    const userId = registerRes.body.data.user.id;
    await User.findByIdAndUpdate(userId, { role: 'admin' });
  }

  const loginRes = await request(app).post('/api/v1/auth/login').send({
    email,
    password,
  });

  expect(loginRes.status).toBe(200);
  return loginRes.body.data.token as string;
};

describe('POST /api/v1/auth/register - Password Hashing', () => {
  it('hashes the password before persisting to the database', async () => {
    const password = 'SecurePass123!';
    await request(app).post('/api/v1/auth/register').send({
      firstName: 'Hash',
      lastName: 'Test',
      email: 'hash.test@swiftchain.com',
      password,
    });

    const stored = await mongoose.connection
      .collection('users')
      .findOne({ email: 'hash.test@swiftchain.com' });

    expect(stored).not.toBeNull();
    expect(stored?.password).toBeDefined();
    expect(stored?.password).not.toBe(password);
    expect(stored?.password).toMatch(/^\$2[aby]\$/);
  });

  it('never returns the password hash in the API response', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({
      firstName: 'Hash',
      lastName: 'Test',
      email: 'hash2.test@swiftchain.com',
      password: 'SecurePass123!',
    });

    expect(res.status).toBe(201);
    expect(res.body.data.user).not.toHaveProperty('password');
  });

  it('can verify the hashed password via login', async () => {
    const password = 'SecurePass123!';
    await request(app).post('/api/v1/auth/register').send({
      firstName: 'Hash',
      lastName: 'Test',
      email: 'hash3.test@swiftchain.com',
      password,
    });

    const loginRes = await request(app).post('/api/v1/auth/login').send({
      email: 'hash3.test@swiftchain.com',
      password,
    });

    expect(loginRes.status).toBe(200);
  });
});

describe('PUT /api/v1/users/:id/password - Password Hashing on Update', () => {
  it('re-hashes the password when it is updated', async () => {
    const token = await registerAndLogin('updatepass@swiftchain.com', 'OldPass123!', 'user');

    // Get the user ID from login response — re-login to get it
    const loginRes = await request(app).post('/api/v1/auth/login').send({
      email: 'updatepass@swiftchain.com',
      password: 'OldPass123!',
    });

    const userId = loginRes.body.data.user.id;

    const newPassword = 'NewPass456!';
    const updateRes = await request(app)
      .put(`/api/v1/users/${userId}/password`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        currentPassword: 'OldPass123!',
        newPassword,
      });

    expect(updateRes.status).toBe(200);

    const stored = await mongoose.connection
      .collection('users')
      .findOne({ email: 'updatepass@swiftchain.com' });
    expect(stored?.password).toBeDefined();
    expect(stored?.password).not.toBe(newPassword);
    expect(stored?.password).toMatch(/^\$2[aby]\$/);

    // Verify new password works
    const newLoginRes = await request(app).post('/api/v1/auth/login').send({
      email: 'updatepass@swiftchain.com',
      password: newPassword,
    });
    expect(newLoginRes.status).toBe(200);
  });

  it('rejects update with incorrect current password', async () => {
    const token = await registerAndLogin('wrongpass@swiftchain.com', 'CorrectPass123!', 'user');

    const loginRes = await request(app).post('/api/v1/auth/login').send({
      email: 'wrongpass@swiftchain.com',
      password: 'CorrectPass123!',
    });

    const userId = loginRes.body.data.user.id;

    const updateRes = await request(app)
      .put(`/api/v1/users/${userId}/password`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        currentPassword: 'WrongCurrentPass!',
        newPassword: 'NewPass456!',
      });

    expect(updateRes.status).toBe(401);
  });

  it('prevents users from updating other users passwords', async () => {
    const token1 = await registerAndLogin('user1@swiftchain.com', 'Pass12345!', 'user');
    const _token2 = await registerAndLogin('user2@swiftchain.com', 'Pass12345!', 'user');

    const loginRes2 = await request(app).post('/api/v1/auth/login').send({
      email: 'user2@swiftchain.com',
      password: 'Pass12345!',
    });

    const userId2 = loginRes2.body.data.user.id;

    const updateRes = await request(app)
      .put(`/api/v1/users/${userId2}/password`)
      .set('Authorization', `Bearer ${token1}`)
      .send({
        currentPassword: 'Pass12345!',
        newPassword: 'NewPass456!',
      });

    expect(updateRes.status).toBe(403);
  });
});

describe('DELETE /api/v1/users/:id - Soft Delete Cascading', () => {
  it('soft-deletes the user and cascades to related DriverProfile and Deliveries', async () => {
    const adminToken = await registerAndLogin(
      'cascade.admin@swiftchain.com',
      'AdminPass123!',
      'admin',
    );

    // Register a driver user
    const driverRes = await request(app).post('/api/v1/auth/register').send({
      firstName: 'Driver',
      lastName: 'User',
      email: 'cascade.driver@swiftchain.com',
      password: 'DriverPass123!',
    });

    expect(driverRes.status).toBe(201);
    const driverId = driverRes.body.data.user.id;

    // Create driver profile
    await DriverProfile.create({
      userId: new mongoose.Types.ObjectId(driverId),
      reputationPoints: 100,
      tier: 'silver',
      totalDeliveries: 5,
      completedDeliveries: 3,
      vehicleDetails: {
        make: 'Toyota',
        model: 'Camry',
        year: 2022,
        plateNumber: 'ABC123',
        capacityKg: 500,
      },
    });

    // Create deliveries where driver is sender, recipient, or driverId
    const delivery1 = await Delivery.create({
      deliveryId: 'DEL-CASCADE-1',
      driverId: driverId,
      userId: driverId,
      sender: new mongoose.Types.ObjectId(driverId),
      recipient: new mongoose.Types.ObjectId(driverId),
      status: 'pending',
      pickupCoordinates: { lat: 0, lng: 0, address: 'A' },
      dropoffCoordinates: { lat: 1, lng: 1, address: 'B' },
    });

    const delivery2 = await Delivery.create({
      deliveryId: 'DEL-CASCADE-2',
      driverId: driverId,
      userId: driverId,
      sender: new mongoose.Types.ObjectId(driverId),
      recipient: new mongoose.Types.ObjectId(driverId),
      status: 'assigned',
      pickupCoordinates: { lat: 0, lng: 0, address: 'A' },
      dropoffCoordinates: { lat: 1, lng: 1, address: 'B' },
    });

    // Soft delete the user
    const deleteRes = await request(app)
      .delete(`/api/v1/users/${driverId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.data.user.isDeleted).toBe(true);
    expect(deleteRes.body.data.cascaded.driverProfile).toBe(true);
    expect(deleteRes.body.data.cascaded.deliveries).toBe(2);

    // Verify user is soft-deleted in DB
    const deletedUser = await User.findById(driverId).setOptions({ includeDeleted: true });
    expect(deletedUser?.isDeleted).toBe(true);
    expect(deletedUser?.deletedAt).toBeDefined();

    // Verify driver profile is soft-deleted
    const deletedProfile = await DriverProfile.findOne({ userId: driverId }).setOptions({
      includeDeleted: true,
    });
    expect(deletedProfile?.isDeleted).toBe(true);

    // Verify deliveries are soft-deleted
    const deletedDelivery1 = await Delivery.findById(delivery1._id).setOptions({
      includeDeleted: true,
    });
    expect(deletedDelivery1?.isDeleted).toBe(true);

    const deletedDelivery2 = await Delivery.findById(delivery2._id).setOptions({
      includeDeleted: true,
    });
    expect(deletedDelivery2?.isDeleted).toBe(true);

    // Verify user is excluded from normal queries
    const normalQuery = await User.findOne({ _id: driverId, isDeleted: { $ne: true } });
    expect(normalQuery).toBeNull();
  });

  it('soft-deletes only the user when no related records exist', async () => {
    const adminToken = await registerAndLogin(
      'cascade.admin2@swiftchain.com',
      'AdminPass123!',
      'admin',
    );

    const driverRes = await request(app).post('/api/v1/auth/register').send({
      firstName: 'Solo',
      lastName: 'Driver',
      email: 'solo.driver@swiftchain.com',
      password: 'DriverPass123!',
    });

    const driverId = driverRes.body.data.user.id;

    const deleteRes = await request(app)
      .delete(`/api/v1/users/${driverId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.data.cascaded.driverProfile).toBe(false);
    expect(deleteRes.body.data.cascaded.deliveries).toBe(0);
  });

  it('returns 409 when deleting an already deleted user', async () => {
    const adminToken = await registerAndLogin(
      'cascade.admin3@swiftchain.com',
      'AdminPass123!',
      'admin',
    );

    const driverRes = await request(app).post('/api/v1/auth/register').send({
      firstName: 'Twice',
      lastName: 'Driver',
      email: 'twice.driver@swiftchain.com',
      password: 'DriverPass123!',
    });

    const driverId = driverRes.body.data.user.id;

    // First delete
    await request(app)
      .delete(`/api/v1/users/${driverId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    // Second delete
    const secondDeleteRes = await request(app)
      .delete(`/api/v1/users/${driverId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(secondDeleteRes.status).toBe(409);
  });
});

describe('POST /api/v1/users/:id/restore - Restore Soft Deleted User', () => {
  it('restores a soft-deleted user', async () => {
    const adminToken = await registerAndLogin(
      'restore.admin@swiftchain.com',
      'AdminPass123!',
      'admin',
    );

    const driverRes = await request(app).post('/api/v1/auth/register').send({
      firstName: 'Restore',
      lastName: 'Driver',
      email: 'restore.driver@swiftchain.com',
      password: 'DriverPass123!',
    });

    const driverId = driverRes.body.data.user.id;

    // Soft delete
    await request(app)
      .delete(`/api/v1/users/${driverId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    // Restore
    const restoreRes = await request(app)
      .post(`/api/v1/users/${driverId}/restore`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(restoreRes.status).toBe(200);
    expect(restoreRes.body.data.user.isDeleted).toBe(false);
    expect(restoreRes.body.data.user.deletedAt).toBeNull();

    // Verify user is accessible again
    const user = await User.findById(driverId);
    expect(user).not.toBeNull();
    expect((user as IUser).isDeleted).toBe(false);
  });

  it('returns 409 when restoring a non-deleted user', async () => {
    const adminToken = await registerAndLogin(
      'restore.admin2@swiftchain.com',
      'AdminPass123!',
      'admin',
    );

    const driverRes = await request(app).post('/api/v1/auth/register').send({
      firstName: 'Active',
      lastName: 'Driver',
      email: 'active.driver@swiftchain.com',
      password: 'DriverPass123!',
    });

    const driverId = driverRes.body.data.user.id;

    const restoreRes = await request(app)
      .post(`/api/v1/users/${driverId}/restore`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(restoreRes.status).toBe(409);
  });
});

describe('GET /api/v1/users/:id - Timestamps and Indexing', () => {
  it('returns timestamps on user creation', async () => {
    const beforeCreate = new Date();
    const res = await request(app).post('/api/v1/auth/register').send({
      firstName: 'Timestamp',
      lastName: 'User',
      email: 'timestamp.user@swiftchain.com',
      password: 'SecurePass123!',
    });

    expect(res.status).toBe(201);

    const stored = await mongoose.connection
      .collection('users')
      .findOne({ email: 'timestamp.user@swiftchain.com' });
    expect(stored?.createdAt).toBeDefined();
    expect(stored?.updatedAt).toBeDefined();

    const afterCreate = new Date();
    const createdAt = new Date(stored!.createdAt);
    expect(createdAt.getTime()).toBeGreaterThanOrEqual(beforeCreate.getTime());
    expect(createdAt.getTime()).toBeLessThanOrEqual(afterCreate.getTime());
  });

  it('updates the updatedAt timestamp on modification', async () => {
    const token = await registerAndLogin('ts.update@swiftchain.com', 'Pass12345!', 'admin');

    const loginRes = await request(app).post('/api/v1/auth/login').send({
      email: 'ts.update@swiftchain.com',
      password: 'Pass12345!',
    });

    const userId = loginRes.body.data.user.id;

    // Get initial updatedAt
    const initialUser = await User.findById(userId);
    const initialUpdatedAt = new Date((initialUser as IUser).updatedAt);

    // Wait a bit to ensure timestamp difference
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Update the user
    const updateRes = await request(app)
      .put(`/api/v1/users/${userId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ firstName: 'Updated' });

    expect(updateRes.status).toBe(200);

    const updatedUser = await User.findById(userId);
    const newUpdatedAt = new Date((updatedUser as IUser).updatedAt);

    expect(newUpdatedAt.getTime()).toBeGreaterThan(initialUpdatedAt.getTime());
  });

  it('enforces unique email index', async () => {
    await request(app).post('/api/v1/auth/register').send({
      firstName: 'Unique',
      lastName: 'User',
      email: 'unique.email@swiftchain.com',
      password: 'SecurePass123!',
    });

    const duplicateRes = await request(app).post('/api/v1/auth/register').send({
      firstName: 'Another',
      lastName: 'User',
      email: 'unique.email@swiftchain.com',
      password: 'SecurePass123!',
    });

    expect(duplicateRes.status).toBe(409);
  });

  it('supports filtering by role and status via compound index', async () => {
    const adminToken = await registerAndLogin('idx.admin@swiftchain.com', 'AdminPass123!', 'admin');

    // Create users with different roles and statuses
    await request(app).post('/api/v1/auth/register').send({
      firstName: 'Admin',
      lastName: 'One',
      email: 'admin1@swiftchain.com',
      password: 'SecurePass123!',
      role: 'admin',
    });

    await request(app).post('/api/v1/auth/register').send({
      firstName: 'User',
      lastName: 'One',
      email: 'user1@swiftchain.com',
      password: 'SecurePass123!',
    });

    // Query with role filter
    const roleRes = await request(app)
      .get('/api/v1/users/deleted?role=admin')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(roleRes.status).toBe(200);
    expect(roleRes.body.data.every((u: IUser) => u.role === 'admin')).toBe(true);
  });

  it('excludes soft-deleted users from normal queries', async () => {
    const adminToken = await registerAndLogin(
      'idx.admin2@swiftchain.com',
      'AdminPass123!',
      'admin',
    );

    const driverRes = await request(app).post('/api/v1/auth/register').send({
      firstName: 'Filter',
      lastName: 'Driver',
      email: 'filter.driver@swiftchain.com',
      password: 'DriverPass123!',
    });

    const driverId = driverRes.body.data.user.id;

    // Verify user is in normal query
    const beforeDelete = await request(app)
      .get(`/api/v1/users/${driverId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(beforeDelete.status).toBe(200);

    // Soft delete
    await request(app)
      .delete(`/api/v1/users/${driverId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    // Verify user is excluded from normal queries
    const afterDelete = await request(app)
      .get(`/api/v1/users/${driverId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(afterDelete.status).toBe(404);
  });

  it('returns soft-deleted users via the deleted endpoint', async () => {
    const adminToken = await registerAndLogin(
      'idx.admin3@swiftchain.com',
      'AdminPass123!',
      'admin',
    );

    const driverRes = await request(app).post('/api/v1/auth/register').send({
      firstName: 'Deleted',
      lastName: 'Driver',
      email: 'deleted.driver@swiftchain.com',
      password: 'DriverPass123!',
    });

    const driverId = driverRes.body.data.user.id;

    // Soft delete
    await request(app)
      .delete(`/api/v1/users/${driverId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    // Query deleted users
    const deletedRes = await request(app)
      .get('/api/v1/users/deleted')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(deletedRes.status).toBe(200);
    expect(deletedRes.body.data.some((u: IUser) => u.id === driverId)).toBe(true);
  });
});

describe('Authentication and Authorization', () => {
  it('requires authentication for user endpoints', async () => {
    const res = await request(app).get('/api/v1/users/123456789012345678901234');
    expect(res.status).toBe(401);
  });

  it('requires admin role for delete endpoint', async () => {
    const userToken = await registerAndLogin('auth.user@swiftchain.com', 'Pass12345!', 'user');

    const loginRes = await request(app).post('/api/v1/auth/login').send({
      email: 'auth.user@swiftchain.com',
      password: 'Pass12345!',
    });

    const userId = loginRes.body.data.user.id;

    const deleteRes = await request(app)
      .delete(`/api/v1/users/${userId}`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(deleteRes.status).toBe(403);
  });

  it('requires admin role for update endpoint', async () => {
    const userToken = await registerAndLogin('auth.user2@swiftchain.com', 'Pass12345!', 'user');

    const loginRes = await request(app).post('/api/v1/auth/login').send({
      email: 'auth.user2@swiftchain.com',
      password: 'Pass12345!',
    });

    const userId = loginRes.body.data.user.id;

    const updateRes = await request(app)
      .put(`/api/v1/users/${userId}`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ firstName: 'Hacker' });

    expect(updateRes.status).toBe(403);
  });
});
