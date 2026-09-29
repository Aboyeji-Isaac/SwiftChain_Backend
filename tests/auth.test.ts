import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import User from '../src/models/User';
import { IUser } from '../src/interfaces/IUser';

// Mock the database connection to prevent the app from connecting to the real DB
import type { Express } from 'express';

// Mock the database connection so app.ts does not open its own connection;
// the in-memory server is connected explicitly below.
jest.mock('../src/config/database', () => ({
  connectDatabase: jest.fn(),
}));

// Mock the logger to keep test output clean
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
  // authService.generateToken reads process.env.JWT_SECRET directly
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_16_chars';
  const mod = await import('../src/app');
  app = mod.default;
});

afterEach(async () => {
  await mongoose.connection.collection('users').deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  // Clean up the users collection between tests
  await User.deleteMany({});
});

/**
 * Helper: Create a user directly in the database for login tests.
 * This goes through the Mongoose model (including the pre-save hash hook)
 * so the password is properly hashed.
 */
const createTestUser = async (overrides: Record<string, unknown> = {}): Promise<IUser> => {
  const defaultUser = {
    email: 'testuser@swiftchain.com',
    password: 'SecurePass123!',
    firstName: 'Test',
    lastName: 'User',
    role: 'user',
    ...overrides,
  };

  return User.create(defaultUser);
};

describe('POST /api/v1/auth/login', () => {
  describe('Successful Login', () => {
    it('should return 200 and a JWT token for valid credentials', async () => {
      await createTestUser();

      const res = await request(app).post('/api/v1/auth/login').send({
        email: 'testuser@swiftchain.com',
        password: 'SecurePass123!',
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe('Login successful');
      expect(res.body.data).toHaveProperty('token');
      expect(res.body.data).toHaveProperty('user');
      expect(res.body.data.user).toHaveProperty('id');
      expect(res.body.data.user.email).toBe('testuser@swiftchain.com');
      expect(res.body.data.user.firstName).toBe('Test');
      expect(res.body.data.user.lastName).toBe('User');
      expect(res.body.data.user.role).toBe('user');
      // Password should never be returned
      expect(res.body.data.user).not.toHaveProperty('password');
    });

    it('should return a valid JWT token structure', async () => {
      await createTestUser();

      const res = await request(app).post('/api/v1/auth/login').send({
        email: 'testuser@swiftchain.com',
        password: 'SecurePass123!',
      });

      expect(res.status).toBe(200);
      const token = res.body.data.token;
      // JWT has three parts separated by dots
      expect(token.split('.')).toHaveLength(3);
    });

    it('should handle case-insensitive email login', async () => {
      await createTestUser({ email: 'user@swiftchain.com' });

      const res = await request(app).post('/api/v1/auth/login').send({
        email: 'USER@SWIFTCHAIN.COM',
        password: 'SecurePass123!',
      });

      expect(res.status).toBe(200);
      expect(res.body.data.user.email).toBe('user@swiftchain.com');
    });

    it('should login a driver user', async () => {
      await createTestUser({ role: 'driver', email: 'driver@swiftchain.com' });

      const res = await request(app).post('/api/v1/auth/login').send({
        email: 'driver@swiftchain.com',
        password: 'SecurePass123!',
      });

      expect(res.status).toBe(200);
      expect(res.body.data.user.role).toBe('driver');
    });
  });

  describe('Authentication Failures', () => {
    it('should return 401 for non-existent email', async () => {
      const res = await request(app).post('/api/v1/auth/login').send({
        email: 'nonexistent@swiftchain.com',
        password: 'SecurePass123!',
      });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('Invalid email or password');
    });

    it('should return 401 for wrong password', async () => {
      await createTestUser();

      const res = await request(app).post('/api/v1/auth/login').send({
        email: 'testuser@swiftchain.com',
        password: 'WrongPassword123!',
      });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('Invalid email or password');
    });

    it('should return 401 for deactivated account', async () => {
      await createTestUser({ isActive: false });

      const res = await request(app).post('/api/v1/auth/login').send({
        email: 'testuser@swiftchain.com',
        password: 'SecurePass123!',
      });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('deactivated');
    });

    it('should use the same error message for invalid email and password to prevent enumeration', async () => {
      await createTestUser();

      const wrongEmailRes = await request(app).post('/api/v1/auth/login').send({
        email: 'wrong@swiftchain.com',
        password: 'SecurePass123!',
      });

      const wrongPasswordRes = await request(app).post('/api/v1/auth/login').send({
        email: 'testuser@swiftchain.com',
        password: 'WrongPassword!',
      });

      // Same generic message to prevent email enumeration
      expect(wrongEmailRes.body.message).toBe(wrongPasswordRes.body.message);
    });
  });

  describe('Validation Errors', () => {
    it('should return 400 for empty body', async () => {
      const res = await request(app).post('/api/v1/auth/login').send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('Validation failed');
      expect(res.body.errors).toBeDefined();
      expect(res.body.errors.length).toBeGreaterThan(0);
    });

    it('should return 400 for invalid email format', async () => {
      const res = await request(app).post('/api/v1/auth/login').send({
        email: 'not-an-email',
        password: 'SecurePass123!',
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.errors).toBeDefined();
    });

    it('should return 400 for missing password', async () => {
      const res = await request(app).post('/api/v1/auth/login').send({
        email: 'testuser@swiftchain.com',
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('should return 400 for missing email', async () => {
      const res = await request(app).post('/api/v1/auth/login').send({
        password: 'SecurePass123!',
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  describe('API Versioning', () => {
    it('should be accessible at /api/v1/auth/login', async () => {
      await createTestUser();

      const res = await request(app).post('/api/v1/auth/login').send({
        email: 'testuser@swiftchain.com',
        password: 'SecurePass123!',
      });

      expect(res.status).toBe(200);
    });

    it('should return 404 for unversioned auth endpoint', async () => {
      const res = await request(app).post('/auth/login').send({
        email: 'testuser@swiftchain.com',
        password: 'SecurePass123!',
      });

      expect(res.status).toBe(404);
    });
  });
});

const validUser = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@example.com',
  password: 'sup3rSecret!',
};

describe('POST /api/v1/auth/register', () => {
  it('registers a new user and returns sanitized data', async () => {
    const res = await request(app).post('/api/v1/auth/register').send(validUser);

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('success', true);
    expect(res.body.data.user).toMatchObject({
      firstName: validUser.firstName,
      lastName: validUser.lastName,
      email: validUser.email,
      role: 'user',
    });
    expect(res.body.data.user).toHaveProperty('id');
    // The password hash must never be returned
    expect(res.body.data.user).not.toHaveProperty('password');
  });

  it('persists the user with a bcrypt-hashed password', async () => {
    await request(app).post('/api/v1/auth/register').send(validUser);

    const stored = await mongoose.connection
      .collection('users')
      .findOne({ email: validUser.email });

    expect(stored).not.toBeNull();
    expect(stored?.password).toBeDefined();
    expect(stored?.password).not.toBe(validUser.password);
    expect(stored?.password).toMatch(/^\$2[aby]\$/); // bcrypt hash prefix
  });

  it('rejects a duplicate email with 409', async () => {
    await request(app).post('/api/v1/auth/register').send(validUser);
    const res = await request(app).post('/api/v1/auth/register').send(validUser);

    expect(res.status).toBe(409);
    expect(res.body).toHaveProperty('success', false);
  });

  it('rejects an invalid email with 400', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ ...validUser, email: 'not-an-email' });

    expect(res.status).toBe(400);
  });

  it('rejects a weak password with 400', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ ...validUser, password: 'short' });

    expect(res.status).toBe(400);
  });

  it('rejects a missing firstName with 400', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ lastName: validUser.lastName, email: validUser.email, password: validUser.password });

    expect(res.status).toBe(400);
  });
});
