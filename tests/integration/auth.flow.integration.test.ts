import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Express } from 'express';

import User from '../../src/models/User';

/**
 * End-to-end Auth flow integration tests.
 *
 * Unlike tests/auth.test.ts (which exercises /login and /register in
 * isolation), this suite chains real requests through the full
 * Controller -> Service -> Model stack: a user is registered through the
 * HTTP API, then logs in through the HTTP API, and the resulting JWT is
 * used against a real protected route to verify the token issued by
 * AuthService actually authorizes downstream requests. All data is
 * persisted to and read back from a real MongoDB instance
 * (mongodb-memory-server) — no inline mocks or hardcoded response bodies.
 */

jest.mock('../../src/config/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

let app: Express;
let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongoServer.getUri();
  process.env.JWT_SECRET = 'integration-test-secret';

  const mod = await import('../../src/app');
  app = mod.default;
  await mongoose.connect(mongoServer.getUri());
});

afterEach(async () => {
  await User.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

const registerPayload = {
  firstName: 'Grace',
  lastName: 'Hopper',
  email: 'grace.hopper@swiftchain.com',
  password: 'CompileThis123!',
};

describe('Auth flow: register -> login -> authorized access', () => {
  it('registers a user, logs in with the same credentials, and reuses the token against a protected route', async () => {
    const registerRes = await request(app)
      .post('/api/v1/auth/register')
      .send({ ...registerPayload, email: 'driver.flow@swiftchain.com' });

    expect(registerRes.status).toBe(201);
    const registeredId = registerRes.body.data.user.id;

    // Promote the registered account to 'driver' directly in the DB,
    // mirroring an admin action, so the login flow issues a driver-scoped token.
    await User.findByIdAndUpdate(registeredId, { role: 'driver' });

    const loginRes = await request(app).post('/api/v1/auth/login').send({
      email: 'driver.flow@swiftchain.com',
      password: registerPayload.password,
    });

    expect(loginRes.status).toBe(200);
    expect(loginRes.body.data.user.id).toBe(registeredId);
    expect(loginRes.body.data.user.role).toBe('driver');

    const token = loginRes.body.data.token as string;

    // The JWT minted by the real /login endpoint must authorize a real
    // protected route guarded by role-based access control.
    const statusRes = await request(app)
      .put(`/api/v1/deliveries/${new mongoose.Types.ObjectId().toHexString()}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'assigned' });

    // 404 (delivery not found) proves the token passed authentication AND
    // authorization — a 401/403 here would mean the issued token is broken.
    expect(statusRes.status).toBe(404);
  });

  it('rejects a login attempt for an account that was never registered', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({
      email: 'ghost@swiftchain.com',
      password: 'DoesNotMatter123!',
    });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('prevents registering the same email twice and still allows the original account to log in', async () => {
    const first = await request(app).post('/api/v1/auth/register').send(registerPayload);
    expect(first.status).toBe(201);

    const duplicate = await request(app).post('/api/v1/auth/register').send(registerPayload);
    expect(duplicate.status).toBe(409);

    const login = await request(app).post('/api/v1/auth/login').send({
      email: registerPayload.email,
      password: registerPayload.password,
    });
    expect(login.status).toBe(200);
  });

  it('denies a default-role user access to a driver/admin-only route after a real login', async () => {
    await request(app)
      .post('/api/v1/auth/register')
      .send({ ...registerPayload, email: 'plain.user@swiftchain.com' });

    const loginRes = await request(app).post('/api/v1/auth/login').send({
      email: 'plain.user@swiftchain.com',
      password: registerPayload.password,
    });

    expect(loginRes.status).toBe(200);
    expect(loginRes.body.data.user.role).toBe('user');

    const token = loginRes.body.data.token as string;

    const statusRes = await request(app)
      .put(`/api/v1/deliveries/${new mongoose.Types.ObjectId().toHexString()}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'assigned' });

    expect(statusRes.status).toBe(403);
    expect(statusRes.body.status).toBe('error');
  });

  it('rejects a tampered token on a protected route', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ ...registerPayload, email: 'tampered@swiftchain.com' });
    expect(res.status).toBe(201);

    const loginRes = await request(app).post('/api/v1/auth/login').send({
      email: 'tampered@swiftchain.com',
      password: registerPayload.password,
    });

    const tamperedToken = `${loginRes.body.data.token as string}tampered`;

    const statusRes = await request(app)
      .put(`/api/v1/deliveries/${new mongoose.Types.ObjectId().toHexString()}/status`)
      .set('Authorization', `Bearer ${tamperedToken}`)
      .send({ status: 'assigned' });

    expect(statusRes.status).toBe(401);
  });

  it('rejects requests to a protected route with no Authorization header at all', async () => {
    const res = await request(app)
      .put(`/api/v1/deliveries/${new mongoose.Types.ObjectId().toHexString()}/status`)
      .send({ status: 'assigned' });

    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/authorization header missing or malformed/i);
  });
});
