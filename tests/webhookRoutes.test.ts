import request from 'supertest';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import User from '../src/models/User';
import { WebhookSubscription, WebhookEvent } from '../src/models/WebhookSubscription';
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
const JWT_SECRET = 'test-secret-key-16chars';

const signToken = (userId: string): string => jwt.sign({ userId }, JWT_SECRET, { expiresIn: '1h' });

const createMerchant = async (): Promise<InstanceType<typeof User>> =>
  User.create({
    firstName: 'Merchant',
    lastName: 'Tester',
    email: `merchant-${Date.now()}-${Math.random()}@example.com`,
    password: 'Password123!',
    role: UserRole.ENTERPRISE,
    status: UserStatus.ACTIVE,
  });

describe('Webhook REST Endpoints (/api/v1/webhooks)', () => {
  let merchant: InstanceType<typeof User>;
  let merchantToken: string;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    await User.deleteMany({});
    await WebhookSubscription.deleteMany({});

    merchant = await createMerchant();
    merchantToken = signToken(merchant._id.toString());
  });

  it('registers a webhook with allowBatch: true', async () => {
    const res = await request(app)
      .post('/api/v1/webhooks')
      .set('Authorization', `Bearer ${merchantToken}`)
      .send({
        url: 'https://example.com/webhook',
        events: [WebhookEvent.DELIVERY_COMPLETED],
        allowBatch: true,
        description: 'Primary callback',
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.webhook.allowBatch).toBe(true);
    expect(res.body.data.secret).toHaveLength(64);
  });

  it('lists registered webhooks for merchant', async () => {
    await WebhookSubscription.create({
      merchantId: merchant._id,
      url: 'https://example.com/hook1',
      secret: 'secret1',
      events: [WebhookEvent.DELIVERY_PENDING],
      allowBatch: true,
    });

    const res = await request(app)
      .get('/api/v1/webhooks')
      .set('Authorization', `Bearer ${merchantToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.webhooks).toHaveLength(1);
    expect(res.body.data.webhooks[0].allowBatch).toBe(true);
  });

  it('updates a webhook subscription allowBatch flag', async () => {
    const webhook = await WebhookSubscription.create({
      merchantId: merchant._id,
      url: 'https://example.com/hook2',
      secret: 'secret2',
      events: [WebhookEvent.DELIVERY_PENDING],
      allowBatch: false,
    });

    const res = await request(app)
      .patch(`/api/v1/webhooks/${webhook._id}`)
      .set('Authorization', `Bearer ${merchantToken}`)
      .send({ allowBatch: true });

    expect(res.status).toBe(200);
    expect(res.body.data.webhook.allowBatch).toBe(true);
  });

  it('rotates a webhook signing secret', async () => {
    const webhook = await WebhookSubscription.create({
      merchantId: merchant._id,
      url: 'https://example.com/hook3',
      secret: 'oldsecret',
      events: [WebhookEvent.DELIVERY_COMPLETED],
    });

    const res = await request(app)
      .post(`/api/v1/webhooks/${webhook._id}/rotate-secret`)
      .set('Authorization', `Bearer ${merchantToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.secret).toBeDefined();
    expect(res.body.data.secret).toHaveLength(64);
  });

  it('deletes a webhook subscription', async () => {
    const webhook = await WebhookSubscription.create({
      merchantId: merchant._id,
      url: 'https://example.com/hook4',
      secret: 'secret4',
      events: [WebhookEvent.DELIVERY_COMPLETED],
    });

    const res = await request(app)
      .delete(`/api/v1/webhooks/${webhook._id}`)
      .set('Authorization', `Bearer ${merchantToken}`);

    expect(res.status).toBe(200);
    const count = await WebhookSubscription.countDocuments({ _id: webhook._id });
    expect(count).toBe(0);
  });
});
