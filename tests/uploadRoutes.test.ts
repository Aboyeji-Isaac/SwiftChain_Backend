/**
 * Integration tests for POST/GET /api/v1/uploads/evidence.
 */

import fsSync from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'evidence-routes-test-'));
process.env.UPLOAD_STORAGE_DRIVER = 'local';
process.env.UPLOAD_LOCAL_DIR = path.relative(process.cwd(), tempDir);
process.env.UPLOAD_MAX_FILE_SIZE_MB = '1';
process.env.APP_BASE_URL = 'http://localhost:3000';

import request from 'supertest';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import User from '../src/models/User';
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
  await fs.rm(tempDir, { recursive: true, force: true });
}, 15_000);

const JWT_SECRET = 'test-secret-key-16chars';

const signToken = (userId: string): string =>
  jwt.sign({ id: userId }, JWT_SECRET, { expiresIn: '1h' });

const createUser = async (): Promise<InstanceType<typeof User>> =>
  User.create({
    firstName: 'Test',
    lastName: 'User',
    email: `user-${Date.now()}-${Math.random()}@example.com`,
    password: 'Password123!',
    role: UserRole.USER,
    status: UserStatus.ACTIVE,
  });

describe('POST /api/v1/uploads/evidence', () => {
  it('returns 401 without a token', async () => {
    const res = await request(app)
      .post('/api/v1/uploads/evidence')
      .field('disputeId', new mongoose.Types.ObjectId().toString())
      .attach('file', Buffer.from('fake-image'), {
        filename: 'photo.jpg',
        contentType: 'image/jpeg',
      });

    expect(res.status).toBe(401);
  });

  it('uploads a file and returns a secure URL for an authenticated user', async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    const user = await createUser();
    const token = signToken(user._id.toString());
    const disputeId = new mongoose.Types.ObjectId().toString();

    const res = await request(app)
      .post('/api/v1/uploads/evidence')
      .set('Authorization', `Bearer ${token}`)
      .field('disputeId', disputeId)
      .attach('file', Buffer.from('fake-image-bytes'), {
        filename: 'photo.jpg',
        contentType: 'image/jpeg',
      });

    expect(res.status).toBe(201);
    expect(res.body.data.evidence.disputeId).toBe(disputeId);
    expect(res.body.data.evidence.url).toContain('/uploads/evidence/');
  });

  it('returns 400 when no file is attached', async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    const user = await createUser();
    const token = signToken(user._id.toString());

    const res = await request(app)
      .post('/api/v1/uploads/evidence')
      .set('Authorization', `Bearer ${token}`)
      .field('disputeId', new mongoose.Types.ObjectId().toString());

    expect(res.status).toBe(400);
  });

  it('returns 415 for a disallowed file type', async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    const user = await createUser();
    const token = signToken(user._id.toString());

    const res = await request(app)
      .post('/api/v1/uploads/evidence')
      .set('Authorization', `Bearer ${token}`)
      .field('disputeId', new mongoose.Types.ObjectId().toString())
      .attach('file', Buffer.from('not-an-image'), {
        filename: 'script.exe',
        contentType: 'application/x-msdownload',
      });

    expect(res.status).toBe(415);
  });
});

describe('GET /api/v1/uploads/evidence/:disputeId', () => {
  it('returns 401 without a token', async () => {
    const res = await request(app).get(
      `/api/v1/uploads/evidence/${new mongoose.Types.ObjectId().toString()}`,
    );
    expect(res.status).toBe(401);
  });

  it('lists evidence uploaded for a dispute', async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    const user = await createUser();
    const token = signToken(user._id.toString());
    const disputeId = new mongoose.Types.ObjectId().toString();

    await request(app)
      .post('/api/v1/uploads/evidence')
      .set('Authorization', `Bearer ${token}`)
      .field('disputeId', disputeId)
      .attach('file', Buffer.from('fake-image-bytes'), {
        filename: 'photo.jpg',
        contentType: 'image/jpeg',
      });

    const res = await request(app)
      .get(`/api/v1/uploads/evidence/${disputeId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(1);
    expect(res.body.data.evidence[0].disputeId).toBe(disputeId);
  });
});
