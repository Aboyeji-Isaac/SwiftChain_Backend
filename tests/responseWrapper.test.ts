/**
 * tests/responseWrapper.test.ts
 *
 * Tests for the standardised API response wrapper (issue #105).
 *
 * Test strategy:
 * ──────────────
 * 1. Unit-test buildSuccess / buildError — pure functions, no Express needed.
 * 2. Unit-test sendSuccess / sendError using a minimal mock of Express Response.
 * 3. Integration-test representative HTTP endpoints via supertest to confirm
 *    that the full Express stack returns the canonical envelope.
 *
 * Follows the project's existing test conventions:
 *   - jest.mock() for database and logger
 *   - MongoMemoryServer for integration tests that hit a real controller
 *   - supertest for HTTP-layer assertions
 */

import type { Response } from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import {
  buildSuccess,
  buildError,
  sendSuccess,
  sendError,
  type ApiResponse,
} from '../src/utils/responseWrapper';

// ─── Global mocks (match existing project pattern) ────────────────────────────

jest.mock('../src/config/database', () => ({
  connectDatabase: jest.fn(),
}));

jest.mock('../src/config/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Creates a minimal mock of an Express Response that records what was sent. */
function mockResponse(): {
  res: Response;
  getStatus: () => number;
  getBody: () => unknown;
} {
  let statusCode = 200;
  let body: unknown;

  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(data: unknown) {
      body = data;
      return this;
    },
  } as unknown as Response;

  return {
    res,
    getStatus: () => statusCode,
    getBody: () => body,
  };
}

// ─── 1. buildSuccess ──────────────────────────────────────────────────────────

describe('buildSuccess()', () => {
  it('returns success=true with data and null error', () => {
    const result = buildSuccess({ id: '123' }, 'Created');
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ id: '123' });
    expect(result.error).toBeNull();
    expect(result.message).toBe('Created');
  });

  it('uses the default message when none is provided', () => {
    const result = buildSuccess(null);
    expect(result.message).toBe('Operation successful');
  });

  it('accepts null data', () => {
    const result = buildSuccess(null, 'Deleted');
    expect(result.data).toBeNull();
    expect(result.success).toBe(true);
  });

  it('accepts array data', () => {
    const result = buildSuccess([1, 2, 3], 'List');
    expect(Array.isArray(result.data)).toBe(true);
    expect((result.data as number[]).length).toBe(3);
  });

  it('has the correct ApiResponse shape', () => {
    const result: ApiResponse<{ name: string }> = buildSuccess({ name: 'test' }, 'ok');
    expect(Object.keys(result).sort()).toEqual(['data', 'error', 'message', 'success'].sort());
  });
});

// ─── 2. buildError ────────────────────────────────────────────────────────────

describe('buildError()', () => {
  it('returns success=false with null data and the error string', () => {
    const result = buildError('Not found', 'Resource not found');
    expect(result.success).toBe(false);
    expect(result.data).toBeNull();
    expect(result.error).toBe('Not found');
    expect(result.message).toBe('Resource not found');
  });

  it('uses error as message when no separate message is provided', () => {
    const result = buildError('Something went wrong');
    expect(result.message).toBe('Something went wrong');
    expect(result.error).toBe('Something went wrong');
  });

  it('has the correct ApiResponse shape', () => {
    const result: ApiResponse<null> = buildError('err');
    expect(Object.keys(result).sort()).toEqual(['data', 'error', 'message', 'success'].sort());
  });
});

// ─── 3. sendSuccess ───────────────────────────────────────────────────────────

describe('sendSuccess()', () => {
  it('writes 200 status and a well-formed envelope by default', () => {
    const { res, getStatus, getBody } = mockResponse();
    sendSuccess(res, { user: { id: '1' } }, 'User found');

    expect(getStatus()).toBe(200);
    const body = getBody() as ApiResponse<{ user: { id: string } }>;
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ user: { id: '1' } });
    expect(body.error).toBeNull();
    expect(body.message).toBe('User found');
  });

  it('respects a custom status code', () => {
    const { res, getStatus } = mockResponse();
    sendSuccess(res, null, 'Created', 201);
    expect(getStatus()).toBe(201);
  });

  it('sends 503 when explicitly passed', () => {
    const { res, getStatus } = mockResponse();
    sendSuccess(res, { status: 'degraded' }, 'Degraded', 503);
    expect(getStatus()).toBe(503);
  });

  it('uses the default message when none is passed', () => {
    const { res, getBody } = mockResponse();
    sendSuccess(res, {});
    expect((getBody() as ApiResponse).message).toBe('Operation successful');
  });

  it('works with generic data types (number)', () => {
    const { res, getBody } = mockResponse();
    sendSuccess(res, 42, 'Count');
    expect((getBody() as ApiResponse<number>).data).toBe(42);
  });

  it('works with generic data types (string)', () => {
    const { res, getBody } = mockResponse();
    sendSuccess(res, 'hello', 'Echo');
    expect((getBody() as ApiResponse<string>).data).toBe('hello');
  });
});

// ─── 4. sendError ─────────────────────────────────────────────────────────────

describe('sendError()', () => {
  it('writes 500 and a well-formed error envelope by default', () => {
    const { res, getStatus, getBody } = mockResponse();
    sendError(res, 'Internal failure');

    expect(getStatus()).toBe(500);
    const body = getBody() as ApiResponse<null>;
    expect(body.success).toBe(false);
    expect(body.data).toBeNull();
    expect(body.error).toBe('Internal failure');
    expect(body.message).toBe('Internal failure');
  });

  it('respects a custom status code', () => {
    const { res, getStatus } = mockResponse();
    sendError(res, 'Not found', 404);
    expect(getStatus()).toBe(404);
  });

  it('uses a separate message when provided', () => {
    const { res, getBody } = mockResponse();
    sendError(res, 'Validation failed', 400, 'Request body is invalid');
    const body = getBody() as ApiResponse<null>;
    expect(body.error).toBe('Validation failed');
    expect(body.message).toBe('Request body is invalid');
  });

  it('produces success=false always', () => {
    const { res, getBody } = mockResponse();
    sendError(res, 'err', 400);
    expect((getBody() as ApiResponse<null>).success).toBe(false);
  });

  it('produces data=null always', () => {
    const { res, getBody } = mockResponse();
    sendError(res, 'err', 400);
    expect((getBody() as ApiResponse<null>).data).toBeNull();
  });
});

// ─── 5. Different HTTP status codes ───────────────────────────────────────────

describe('sendSuccess() with varied HTTP status codes', () => {
  const cases: Array<[number, string]> = [
    [200, 'OK'],
    [201, 'Created'],
    [202, 'Accepted'],
    [206, 'Partial Content'],
  ];

  it.each(cases)('sends status %i (%s) correctly', (code) => {
    const { res, getStatus, getBody } = mockResponse();
    sendSuccess(res, { result: true }, 'ok', code);
    expect(getStatus()).toBe(code);
    expect((getBody() as ApiResponse).success).toBe(true);
  });
});

describe('sendError() with varied HTTP status codes', () => {
  const cases: Array<[number, string]> = [
    [400, 'Bad Request'],
    [401, 'Unauthorized'],
    [403, 'Forbidden'],
    [404, 'Not Found'],
    [409, 'Conflict'],
    [422, 'Unprocessable Entity'],
    [500, 'Internal Server Error'],
    [502, 'Bad Gateway'],
    [503, 'Service Unavailable'],
  ];

  it.each(cases)('sends status %i (%s) correctly', (code, label) => {
    const { res, getStatus, getBody } = mockResponse();
    sendError(res, label, code);
    expect(getStatus()).toBe(code);
    expect((getBody() as ApiResponse<null>).success).toBe(false);
  });
});

// ─── 6. Integration: auth endpoints via supertest ────────────────────────────

describe('Integration — Auth endpoints follow the ApiResponse envelope', () => {
  let app: import('express').Express;
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    // Ensure JWT_SECRET is set — authService.generateToken reads process.env directly
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_for_responseWrapper_tests';
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    const mod = await import('../src/app');
    app = mod.default;
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  afterEach(async () => {
    await mongoose.connection.collection('users').deleteMany({});
  });

  const validUser = {
    firstName: 'Swift',
    lastName: 'Test',
    email: 'wrapper@swiftchain.com',
    password: 'SecurePass123!',
  };

  it('POST /api/v1/auth/register — success envelope has correct shape', async () => {
    const res = await request(app).post('/api/v1/auth/register').send(validUser);

    expect(res.status).toBe(201);
    // Canonical fields
    expect(res.body).toHaveProperty('success', true);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('error', null);
    expect(res.body).toHaveProperty('message');
    expect(typeof res.body.message).toBe('string');
    // No legacy "status" field
    expect(res.body).not.toHaveProperty('status');
  });

  it('POST /api/v1/auth/login — success envelope has correct shape', async () => {
    // Register a fresh user for this test
    await request(app).post('/api/v1/auth/register').send(validUser);

    // Ensure JWT_SECRET is set so authService.generateToken() does not throw
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_for_responseWrapper_tests';

    const res = await request(app).post('/api/v1/auth/login').send({
      email: validUser.email,
      password: validUser.password,
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('token');
    expect(res.body.error).toBeNull();
    expect(res.body.message).toBe('Login successful');
  });

  it('POST /api/v1/auth/login — error envelope has correct shape (wrong password)', async () => {
    await request(app).post('/api/v1/auth/register').send(validUser);

    const res = await request(app).post('/api/v1/auth/login').send({
      email: validUser.email,
      password: 'WrongPassword!',
    });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.data).toBeNull();
    expect(typeof res.body.error).toBe('string');
    expect(typeof res.body.message).toBe('string');
  });

  it('POST /api/v1/auth/login — validation error envelope has correct shape', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.data).toBeNull();
    expect(res.body.error).toBe('Validation failed');
    // Validation errors array should be present
    expect(Array.isArray(res.body.errors)).toBe(true);
  });

  it('404 handler returns the canonical envelope', async () => {
    const res = await request(app).get('/api/v1/this-route-does-not-exist');

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.data).toBeNull();
    expect(typeof res.body.error).toBe('string');
    expect(typeof res.body.message).toBe('string');
  });

  it('POST /api/v1/auth/register — duplicate email returns canonical error envelope', async () => {
    await request(app).post('/api/v1/auth/register').send(validUser);
    const res = await request(app).post('/api/v1/auth/register').send(validUser);

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.data).toBeNull();
    expect(typeof res.body.error).toBe('string');
  });
});

// ─── 7. Integration: health endpoint ─────────────────────────────────────────

describe('Integration — GET /api/v1/health follows the ApiResponse envelope', () => {
  let app: import('express').Express;

  beforeAll(async () => {
    const mod = await import('../src/app');
    app = mod.default;
  });

  it('returns an envelope with success, data, error, message fields', async () => {
    const res = await request(app).get('/api/v1/health');

    // Status is either 200 (healthy) or 503 (degraded) — both valid
    expect([200, 503]).toContain(res.status);

    expect(res.body).toHaveProperty('success');
    expect(typeof res.body.success).toBe('boolean');
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('error');
    expect(res.body).toHaveProperty('message');
    expect(typeof res.body.message).toBe('string');
    // No legacy "status" field at the top level
    expect(res.body).not.toHaveProperty('status');
  });
});
