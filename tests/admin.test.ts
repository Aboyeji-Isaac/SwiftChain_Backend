import request from 'supertest';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import User from '../src/models/User';
import { UserRole, UserStatus } from '../src/interfaces/IUser';

// ─── Module mocks ──────────────────────────────────────────────────────────────

jest.mock('../src/config/database', () => ({
  connectDatabase: jest.fn(),
}));

jest.mock('../src/config/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

// ─── In-memory MongoDB ─────────────────────────────────────────────────────────

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

// ─── Helpers ───────────────────────────────────────────────────────────────────

const JWT_SECRET = 'test-secret-key-16chars';

/** Mint a signed JWT for the given user id. */
const signToken = (userId: string): string =>
  jwt.sign({ id: userId }, JWT_SECRET, { expiresIn: '1h' });

/** Create a User document directly — bypasses HTTP so passwords are hashed by the pre-save hook. */
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

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('PUT /api/v1/admin/users/:id/suspend', () => {
  // ── 200 Happy paths ───────────────────────────────────────────────────────────

  describe('200 – successful suspension', () => {
    it('suspends an active user and returns the updated document', async () => {
      process.env.JWT_SECRET = JWT_SECRET;

      const admin = await createUser({ role: UserRole.ADMIN });
      const target = await createUser({ role: UserRole.USER });
      const token = signToken(admin._id.toString());

      const res = await request(app)
        .put(`/api/v1/admin/users/${target._id}/suspend`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'Fraudulent activity detected.' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.user.status).toBe('suspended');
    });

    it('returns the message "User has been suspended successfully."', async () => {
      process.env.JWT_SECRET = JWT_SECRET;

      const admin = await createUser({ role: UserRole.ADMIN });
      const target = await createUser({ role: UserRole.USER });
      const token = signToken(admin._id.toString());

      const res = await request(app)
        .put(`/api/v1/admin/users/${target._id}/suspend`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'Spam behaviour.' });

      expect(res.body.message).toBe('User has been suspended successfully.');
    });

    it('persists the suspension to the database', async () => {
      process.env.JWT_SECRET = JWT_SECRET;

      const admin = await createUser({ role: UserRole.ADMIN });
      const target = await createUser({ role: UserRole.USER });
      const token = signToken(admin._id.toString());

      await request(app)
        .put(`/api/v1/admin/users/${target._id}/suspend`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'Policy violation.' });

      const refreshed = await User.findById(target._id);
      expect(refreshed?.status).toBe(UserStatus.SUSPENDED);
      expect(refreshed?.suspendedReason).toBe('Policy violation.');
      expect(refreshed?.suspendedAt).toBeDefined();
    });

    it('does not expose the password hash in the response', async () => {
      process.env.JWT_SECRET = JWT_SECRET;

      const admin = await createUser({ role: UserRole.ADMIN });
      const target = await createUser({ role: UserRole.USER });
      const token = signToken(admin._id.toString());

      const res = await request(app)
        .put(`/api/v1/admin/users/${target._id}/suspend`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'Test.' });

      expect(res.body.data.user.password).toBeUndefined();
    });

    it('bans a user when ban=true is provided', async () => {
      process.env.JWT_SECRET = JWT_SECRET;

      const admin = await createUser({ role: UserRole.ADMIN });
      const target = await createUser({ role: UserRole.USER });
      const token = signToken(admin._id.toString());

      const res = await request(app)
        .put(`/api/v1/admin/users/${target._id}/suspend`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'Repeated abuse.', ban: true });

      expect(res.status).toBe(200);
      expect(res.body.data.user.status).toBe('banned');
      expect(res.body.message).toBe('User has been banned successfully.');
    });

    it('suspends a driver account the same as a regular user', async () => {
      process.env.JWT_SECRET = JWT_SECRET;

      const admin = await createUser({ role: UserRole.ADMIN });
      const driver = await createUser({ role: UserRole.DRIVER });
      const token = signToken(admin._id.toString());

      const res = await request(app)
        .put(`/api/v1/admin/users/${driver._id}/suspend`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'Dangerous driving reported.' });

      expect(res.status).toBe(200);
      expect(res.body.data.user.status).toBe('suspended');
    });

    it('returns the id field as a string in the response', async () => {
      process.env.JWT_SECRET = JWT_SECRET;

      const admin = await createUser({ role: UserRole.ADMIN });
      const target = await createUser({ role: UserRole.USER });
      const token = signToken(admin._id.toString());

      const res = await request(app)
        .put(`/api/v1/admin/users/${target._id}/suspend`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'Test id field.' });

      expect(typeof res.body.data.user.id).toBe('string');
    });
  });

  // ── 400 Validation errors ─────────────────────────────────────────────────────

  describe('400 – validation errors', () => {
    it('returns 400 when reason is missing', async () => {
      process.env.JWT_SECRET = JWT_SECRET;

      const admin = await createUser({ role: UserRole.ADMIN });
      const target = await createUser({ role: UserRole.USER });
      const token = signToken(admin._id.toString());

      const res = await request(app)
        .put(`/api/v1/admin/users/${target._id}/suspend`)
        .set('Authorization', `Bearer ${token}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/reason/i);
    });

    it('returns 400 when reason is an empty string', async () => {
      process.env.JWT_SECRET = JWT_SECRET;

      const admin = await createUser({ role: UserRole.ADMIN });
      const target = await createUser({ role: UserRole.USER });
      const token = signToken(admin._id.toString());

      const res = await request(app)
        .put(`/api/v1/admin/users/${target._id}/suspend`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: '   ' });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/reason/i);
    });

    it('returns 400 when ban is not a boolean', async () => {
      process.env.JWT_SECRET = JWT_SECRET;

      const admin = await createUser({ role: UserRole.ADMIN });
      const target = await createUser({ role: UserRole.USER });
      const token = signToken(admin._id.toString());

      const res = await request(app)
        .put(`/api/v1/admin/users/${target._id}/suspend`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'Valid reason.', ban: 'yes' });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/ban/i);
    });

    it('returns 400 when :id is not a valid ObjectId', async () => {
      process.env.JWT_SECRET = JWT_SECRET;

      const admin = await createUser({ role: UserRole.ADMIN });
      const token = signToken(admin._id.toString());

      const res = await request(app)
        .put('/api/v1/admin/users/not-an-objectid/suspend')
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'Test.' });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/invalid user id/i);
    });
  });

  // ── 401 Authentication errors ─────────────────────────────────────────────────

  describe('401 – authentication errors', () => {
    it('returns 401 when no Authorization header is provided', async () => {
      const target = await createUser({ role: UserRole.USER });

      const res = await request(app)
        .put(`/api/v1/admin/users/${target._id}/suspend`)
        .send({ reason: 'Test.' });

      expect(res.status).toBe(401);
    });

    it('returns 401 when the token is malformed', async () => {
      process.env.JWT_SECRET = JWT_SECRET;
      const target = await createUser({ role: UserRole.USER });

      const res = await request(app)
        .put(`/api/v1/admin/users/${target._id}/suspend`)
        .set('Authorization', 'Bearer this.is.not.a.valid.token')
        .send({ reason: 'Test.' });

      expect(res.status).toBe(401);
    });

    it('returns 401 when the token is signed with a different secret', async () => {
      process.env.JWT_SECRET = JWT_SECRET;

      const admin = await createUser({ role: UserRole.ADMIN });
      const target = await createUser({ role: UserRole.USER });
      // Signed with the wrong secret
      const badToken = jwt.sign({ id: admin._id.toString() }, 'wrong-secret', { expiresIn: '1h' });

      const res = await request(app)
        .put(`/api/v1/admin/users/${target._id}/suspend`)
        .set('Authorization', `Bearer ${badToken}`)
        .send({ reason: 'Test.' });

      expect(res.status).toBe(401);
    });

    it('returns 401 when the token references a non-existent user', async () => {
      process.env.JWT_SECRET = JWT_SECRET;

      const ghostId = new mongoose.Types.ObjectId().toString();
      const token = signToken(ghostId);
      const target = await createUser({ role: UserRole.USER });

      const res = await request(app)
        .put(`/api/v1/admin/users/${target._id}/suspend`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'Test.' });

      expect(res.status).toBe(401);
    });
  });

  // ── 403 Authorisation errors ──────────────────────────────────────────────────

  describe('403 – authorisation errors', () => {
    it('returns 403 when a regular user tries to call the endpoint', async () => {
      process.env.JWT_SECRET = JWT_SECRET;

      const regularUser = await createUser({ role: UserRole.USER });
      const target = await createUser({ role: UserRole.USER });
      const token = signToken(regularUser._id.toString());

      const res = await request(app)
        .put(`/api/v1/admin/users/${target._id}/suspend`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'Test.' });

      expect(res.status).toBe(403);
    });

    it('returns 403 when a driver tries to call the endpoint', async () => {
      process.env.JWT_SECRET = JWT_SECRET;

      const driver = await createUser({ role: UserRole.DRIVER });
      const target = await createUser({ role: UserRole.USER });
      const token = signToken(driver._id.toString());

      const res = await request(app)
        .put(`/api/v1/admin/users/${target._id}/suspend`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'Test.' });

      expect(res.status).toBe(403);
    });

    it('returns 403 when an admin tries to suspend another admin', async () => {
      process.env.JWT_SECRET = JWT_SECRET;

      const admin = await createUser({ role: UserRole.ADMIN });
      const targetAdmin = await createUser({ role: UserRole.ADMIN });
      const token = signToken(admin._id.toString());

      const res = await request(app)
        .put(`/api/v1/admin/users/${targetAdmin._id}/suspend`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'Test.' });

      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/admin/i);
    });

    it('returns 403 when a suspended admin tries to call the endpoint', async () => {
      process.env.JWT_SECRET = JWT_SECRET;

      const suspendedAdmin = await createUser({
        role: UserRole.ADMIN,
        status: UserStatus.SUSPENDED,
      });
      const target = await createUser({ role: UserRole.USER });
      const token = signToken(suspendedAdmin._id.toString());

      const res = await request(app)
        .put(`/api/v1/admin/users/${target._id}/suspend`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'Test.' });

      expect(res.status).toBe(403);
    });
  });

  // ── 404 Not found ─────────────────────────────────────────────────────────────

  describe('404 – not found', () => {
    it('returns 404 when the target user does not exist', async () => {
      process.env.JWT_SECRET = JWT_SECRET;

      const admin = await createUser({ role: UserRole.ADMIN });
      const token = signToken(admin._id.toString());
      const nonExistentId = new mongoose.Types.ObjectId().toString();

      const res = await request(app)
        .put(`/api/v1/admin/users/${nonExistentId}/suspend`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'Test.' });

      expect(res.status).toBe(404);
      expect(res.body.message).toMatch(/user not found/i);
    });
  });

  // ── 409 Conflict ──────────────────────────────────────────────────────────────

  describe('409 – conflict', () => {
    it('returns 409 when the user is already suspended', async () => {
      process.env.JWT_SECRET = JWT_SECRET;

      const admin = await createUser({ role: UserRole.ADMIN });
      const target = await createUser({
        role: UserRole.USER,
        status: UserStatus.SUSPENDED,
      });
      const token = signToken(admin._id.toString());

      const res = await request(app)
        .put(`/api/v1/admin/users/${target._id}/suspend`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'Already suspended.' });

      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/already suspended/i);
    });

    it('returns 409 when the user is already banned and ban=true is sent', async () => {
      process.env.JWT_SECRET = JWT_SECRET;

      const admin = await createUser({ role: UserRole.ADMIN });
      const target = await createUser({
        role: UserRole.USER,
        status: UserStatus.BANNED,
      });
      const token = signToken(admin._id.toString());

      const res = await request(app)
        .put(`/api/v1/admin/users/${target._id}/suspend`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'Already banned.', ban: true });

      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/already banned/i);
    });
  });

  // ── 422 Business rule violations ──────────────────────────────────────────────

  describe('422 – business rule violations', () => {
    it('returns 422 when an admin tries to suspend their own account', async () => {
      process.env.JWT_SECRET = JWT_SECRET;

      const admin = await createUser({ role: UserRole.ADMIN });
      const token = signToken(admin._id.toString());

      const res = await request(app)
        .put(`/api/v1/admin/users/${admin._id}/suspend`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'Self-suspension test.' });

      expect(res.status).toBe(422);
      expect(res.body.message).toMatch(/cannot suspend or ban their own/i);
    });
  });

  // ── Routing ───────────────────────────────────────────────────────────────────

  describe('routing', () => {
    it('returns 404 for GET on the same path', async () => {
      const res = await request(app).get('/api/v1/admin/users/someid/suspend');
      // No token — hits 401 before 404, which is correct auth-first behaviour
      expect([401, 404]).toContain(res.status);
    });
  });
});
