import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { Delivery } from '../src/models/Delivery';

jest.mock('../src/config/database', () => ({
  connectDatabase: jest.fn(),
}));

jest.mock('../src/config/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

const mockDeliveryInput = {
  trackingNumber: 'SWIFT-001',
  customer: {
    name: 'John Doe',
    phone: '+1234567890',
    email: 'john@example.com',
  },
  pickup: {
    address: '123 Pickup St',
    city: 'New York',
    state: 'NY',
    zipCode: '10001',
    instructions: 'Ring bell',
  },
  dropoff: {
    address: '456 Dropoff Ave',
    city: 'Brooklyn',
    state: 'NY',
    zipCode: '11201',
  },
  package: {
    description: 'Electronics',
    weight: 2.5,
    size: 'Medium',
    isFragile: true,
    requiresSignature: true,
  },
  deliveryFee: 15.99,
  escrowAmount: 150.0,
};

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();
  await mongoose.connect(uri);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await Delivery.deleteMany({});
  // Idempotency keys are global (key, endpoint) pairs in Redis/Mongo — clear
  // them too so reused keys between tests replay stale cached responses.
  const collections = mongoose.connection.collections;
  for (const name of Object.keys(collections)) {
    if (name === 'idempotencyrecords') {
      await collections[name].deleteMany({});
    }
  }
});

describe('Delivery API — POST /api/v1/deliveries', () => {
  it('should create a new delivery', async () => {
    const res = await request(app)
      .post('/api/v1/deliveries')
      .set('Idempotency-Key', `test-${Date.now()}-${Math.random()}`)
      .send(mockDeliveryInput);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.trackingNumber).toBe('SWIFT-001');
    expect(res.body.data.isDeleted).toBe(false);
  });

  it('should reject duplicate tracking numbers', async () => {
    await request(app)
      .post('/api/v1/deliveries')
      .set('Idempotency-Key', 'dup-1')
      .send(mockDeliveryInput);
    const res = await request(app)
      .post('/api/v1/deliveries')
      .set('Idempotency-Key', 'dup-2')
      .send(mockDeliveryInput);

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
  });

  it('should reject invalid input (missing required fields)', async () => {
    const res = await request(app)
      .post('/api/v1/deliveries')
      .set('Idempotency-Key', 'invalid-1')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

describe('Delivery API — GET /api/v1/deliveries', () => {
  it('should list deliveries excluding soft-deleted', async () => {
    await Delivery.create(mockDeliveryInput);
    await Delivery.create({
      ...mockDeliveryInput,
      trackingNumber: 'SWIFT-002',
    });

    const res = await request(app).get('/api/v1/deliveries');

    expect(res.status).toBe(200);
    expect(res.body.data.deliveries).toHaveLength(2);
  });

  it('should paginate results', async () => {
    for (let i = 0; i < 5; i++) {
      await Delivery.create({
        ...mockDeliveryInput,
        trackingNumber: `SWIFT-00${i + 1}`,
      });
    }

    const res = await request(app).get('/api/v1/deliveries?page=1&limit=2');

    expect(res.status).toBe(200);
    expect(res.body.data.deliveries).toHaveLength(2);
    expect(res.body.data.meta.total).toBe(5);
    expect(res.body.data.meta.totalPages).toBe(3);
  });

  it('should filter by status', async () => {
    await Delivery.create(mockDeliveryInput);
    await Delivery.create({
      ...mockDeliveryInput,
      trackingNumber: 'SWIFT-002',
      status: 'assigned',
    });

    const res = await request(app).get('/api/v1/deliveries?status=pending');

    expect(res.status).toBe(200);
    expect(res.body.data.deliveries).toHaveLength(1);
    expect(res.body.data.deliveries[0].status).toBe('pending');
  });

  it('should search by tracking number', async () => {
    await Delivery.create(mockDeliveryInput);
    await Delivery.create({
      ...mockDeliveryInput,
      trackingNumber: 'OTHER-001',
    });

    const res = await request(app).get('/api/v1/deliveries?search=SWIFT');

    expect(res.status).toBe(200);
    expect(res.body.data.deliveries).toHaveLength(1);
  });
});

describe('Delivery API — GET /api/v1/deliveries/:id', () => {
  it('should retrieve a delivery by ID', async () => {
    const created = await Delivery.create(mockDeliveryInput);
    const res = await request(app).get(`/api/v1/deliveries/${created._id}`);

    expect(res.status).toBe(200);
    expect(res.body.data.trackingNumber).toBe('SWIFT-001');
  });

  it('should return 404 for non-existent delivery', async () => {
    const fakeId = new mongoose.Types.ObjectId().toHexString();
    const res = await request(app).get(`/api/v1/deliveries/${fakeId}`);

    expect(res.status).toBe(404);
  });

  it('should return 400 for invalid ID format', async () => {
    const res = await request(app).get('/api/v1/deliveries/invalid-id');

    expect(res.status).toBe(400);
  });

  it('should not return soft-deleted deliveries by ID', async () => {
    const created = await Delivery.create(mockDeliveryInput);
    await created.softDelete();

    const res = await request(app).get(`/api/v1/deliveries/${created._id}`);

    expect(res.status).toBe(404);
  });
});

describe('Delivery API — PATCH /api/v1/deliveries/:id', () => {
  it('should update a delivery', async () => {
    const created = await Delivery.create(mockDeliveryInput);
    const res = await request(app)
      .patch(`/api/v1/deliveries/${created._id}`)
      .send({ notes: 'Updated notes', status: 'assigned' });

    expect(res.status).toBe(200);
    expect(res.body.data.notes).toBe('Updated notes');
    expect(res.body.data.status).toBe('assigned');
  });
});

describe('Delivery API — PATCH /api/v1/deliveries/:id/archive', () => {
  it('should archive (soft-delete) a delivery', async () => {
    const created = await Delivery.create(mockDeliveryInput);
    const res = await request(app).patch(`/api/v1/deliveries/${created._id}/archive`);

    expect(res.status).toBe(200);
    expect(res.body.data.isDeleted).toBe(true);
    expect(res.body.data.deletedAt).toBeTruthy();
    expect(res.body.message).toBe('Delivery archived successfully');
  });

  it('should return 409 if already archived', async () => {
    const created = await Delivery.create(mockDeliveryInput);
    await created.softDelete();

    const res = await request(app).patch(`/api/v1/deliveries/${created._id}/archive`);

    expect(res.status).toBe(409);
  });

  it('should exclude archived deliveries from list', async () => {
    await Delivery.create(mockDeliveryInput);
    const d2 = await Delivery.create({
      ...mockDeliveryInput,
      trackingNumber: 'SWIFT-002',
    });
    await d2.softDelete();

    const res = await request(app).get('/api/v1/deliveries');

    expect(res.status).toBe(200);
    expect(res.body.data.deliveries).toHaveLength(1);
    expect(res.body.data.deliveries[0].trackingNumber).toBe('SWIFT-001');
  });
});

describe('Delivery API — PATCH /api/v1/deliveries/:id/restore', () => {
  it('should restore an archived delivery', async () => {
    const created = await Delivery.create(mockDeliveryInput);
    await created.softDelete();

    const res = await request(app).patch(`/api/v1/deliveries/${created._id}/restore`);

    expect(res.status).toBe(200);
    expect(res.body.data.isDeleted).toBe(false);
    expect(res.body.data.deletedAt).toBeNull();
    expect(res.body.message).toBe('Delivery restored successfully');
  });

  it('should return 409 if delivery is not archived', async () => {
    const created = await Delivery.create(mockDeliveryInput);
    const res = await request(app).patch(`/api/v1/deliveries/${created._id}/restore`);

    expect(res.status).toBe(409);
  });

  it('restored delivery should appear in list', async () => {
    const created = await Delivery.create(mockDeliveryInput);
    await created.softDelete();
    await created.restore();

    const res = await request(app).get('/api/v1/deliveries');

    expect(res.status).toBe(200);
    expect(res.body.data.deliveries).toHaveLength(1);
  });
});

describe('Delivery API — GET /api/v1/deliveries/archived', () => {
  it('should list archived deliveries', async () => {
    const created = await Delivery.create(mockDeliveryInput);
    await created.softDelete();

    const res = await request(app).get('/api/v1/deliveries/archived');

    expect(res.status).toBe(200);
    expect(res.body.data.deliveries).toHaveLength(1);
    expect(res.body.data.deliveries[0].isDeleted).toBe(true);
  });

  it('should return empty list when no archived deliveries', async () => {
    await Delivery.create(mockDeliveryInput);

    const res = await request(app).get('/api/v1/deliveries/archived');

    expect(res.status).toBe(200);
    expect(res.body.data.deliveries).toHaveLength(0);
  });

  it('should not include non-archived deliveries', async () => {
    await Delivery.create(mockDeliveryInput);
    const d2 = await Delivery.create({
      ...mockDeliveryInput,
      trackingNumber: 'SWIFT-002',
    });
    await d2.softDelete();

    const res = await request(app).get('/api/v1/deliveries/archived');

    expect(res.status).toBe(200);
    expect(res.body.data.deliveries).toHaveLength(1);
  });
});
