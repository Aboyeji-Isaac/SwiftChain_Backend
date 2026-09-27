import request from 'supertest';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import User from '../src/models/User';
import Delivery, { DeliveryStatus } from '../src/models/Delivery';
import Dispute, { DisputeReason, DisputeStatus } from '../src/models/Dispute';
import { UserRole, UserStatus } from '../src/interfaces/IUser';

// ─── Module mocks ──────────────────────────────────────────────────────

jest.mock('../src/config/database', () => ({
  connectDatabase: jest.fn(),
}));

jest.mock('../src/config/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../src/blockchain/soroban.service', () => ({
  sorobanService: {
    getLatestLedger: jest.fn().mockResolvedValue(555555),
  },
}));

// ─── In-memory MongoDB ─────────────────────────────────────────────────

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

// ─── Helpers ───────────────────────────────────────────────────────────

const JWT_SECRET = 'test-secret-key-16chars';

const signToken = (userId: string): string => jwt.sign({ userId }, JWT_SECRET, { expiresIn: '1h' });

const createUser = async (
  overrides: Partial<{ role: UserRole; status: UserStatus }> = {},
): Promise<InstanceType<typeof User>> => {
  return User.create({
    firstName: 'Test',
    lastName: 'User',
    email: `user-${Date.now()}-${Math.random()}@example.com`,
    password: 'Password123!',
    role: overrides.role ?? UserRole.USER,
    status: overrides.status ?? UserStatus.ACTIVE,
  });
};

const createDelivery = async (overrides: {
  userId: string;
  driverId?: string;
  status?: DeliveryStatus;
}) => {
  return Delivery.create({
    userId: overrides.userId,
    driverId: overrides.driverId,
    status: overrides.status ?? DeliveryStatus.IN_PROGRESS,
    pickupCoordinates: { lat: 1, lng: 1, address: 'Pickup' },
    dropoffCoordinates: { lat: 2, lng: 2, address: 'Dropoff' },
  });
};

const validBody = (deliveryId: string) => ({
  deliveryId,
  reason: DisputeReason.DAMAGED_PACKAGE,
  description: 'The package arrived with visible damage to the packaging and contents.',
});

// ─── POST /api/v1/disputes ──────────────────────────────────────────────

describe('POST /api/v1/disputes', () => {
  describe('201 - success', () => {
    it('opens a dispute for the customer of an active delivery', async () => {
      process.env.JWT_SECRET = JWT_SECRET;

      const customer = await createUser();
      const driver = await createUser({ role: UserRole.DRIVER });
      const delivery = await createDelivery({
        userId: customer._id.toString(),
        driverId: driver._id.toString(),
      });
      const token = signToken(customer._id.toString());

      const res = await request(app)
        .post('/api/v1/disputes')
        .set('Authorization', `Bearer ${token}`)
        .send(validBody(delivery._id.toString()));

      expect(res.status).toBe(201);
      expect(res.body.data.dispute.status).toBe('open');
      expect(res.body.data.dispute.deliveryId).toBe(delivery._id.toString());
      expect(res.body.data.dispute.raisedAtLedger).toBe(555555);
    });

    it('opens a dispute for the assigned driver of an active delivery', async () => {
      process.env.JWT_SECRET = JWT_SECRET;

      const customer = await createUser();
      const driver = await createUser({ role: UserRole.DRIVER });
      const delivery = await createDelivery({
        userId: customer._id.toString(),
        driverId: driver._id.toString(),
        status: DeliveryStatus.ASSIGNED,
      });
      const token = signToken(driver._id.toString());

      const res = await request(app)
        .post('/api/v1/disputes')
        .set('Authorization', `Bearer ${token}`)
        .send(validBody(delivery._id.toString()));

      expect(res.status).toBe(201);
    });

    it('persists the dispute to the database', async () => {
      process.env.JWT_SECRET = JWT_SECRET;

      const customer = await createUser();
      const delivery = await createDelivery({ userId: customer._id.toString() });
      const token = signToken(customer._id.toString());

      await request(app)
        .post('/api/v1/disputes')
        .set('Authorization', `Bearer ${token}`)
        .send(validBody(delivery._id.toString()));

      const disputes = await Dispute.find({ deliveryId: delivery._id.toString() });
      expect(disputes).toHaveLength(1);
      expect(disputes[0].raisedBy).toBe(customer._id.toString());
    });
  });

  describe('400 - validation errors', () => {
    it('returns 400 when deliveryId is missing', async () => {
      process.env.JWT_SECRET = JWT_SECRET;
      const customer = await createUser();
      const token = signToken(customer._id.toString());

      const res = await request(app)
        .post('/api/v1/disputes')
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: DisputeReason.OTHER, description: 'A description long enough.' });

      expect(res.status).toBe(400);
    });

    it('returns 400 when reason is invalid', async () => {
      process.env.JWT_SECRET = JWT_SECRET;
      const customer = await createUser();
      const delivery = await createDelivery({ userId: customer._id.toString() });
      const token = signToken(customer._id.toString());

      const res = await request(app)
        .post('/api/v1/disputes')
        .set('Authorization', `Bearer ${token}`)
        .send({
          deliveryId: delivery._id.toString(),
          reason: 'not_a_real_reason',
          description: 'A description long enough.',
        });

      expect(res.status).toBe(400);
    });

    it('returns 400 when description is too short', async () => {
      process.env.JWT_SECRET = JWT_SECRET;
      const customer = await createUser();
      const delivery = await createDelivery({ userId: customer._id.toString() });
      const token = signToken(customer._id.toString());

      const res = await request(app)
        .post('/api/v1/disputes')
        .set('Authorization', `Bearer ${token}`)
        .send({
          deliveryId: delivery._id.toString(),
          reason: DisputeReason.OTHER,
          description: 'short',
        });

      expect(res.status).toBe(400);
    });

    it('returns 400 when deliveryId is not a valid ObjectId', async () => {
      process.env.JWT_SECRET = JWT_SECRET;
      const customer = await createUser();
      const token = signToken(customer._id.toString());

      const res = await request(app)
        .post('/api/v1/disputes')
        .set('Authorization', `Bearer ${token}`)
        .send(validBody('not-an-objectid'));

      expect(res.status).toBe(400);
    });
  });

  describe('401 - authentication errors', () => {
    it('returns 401 when no Authorization header is provided', async () => {
      const customer = await createUser();
      const delivery = await createDelivery({ userId: customer._id.toString() });

      const res = await request(app)
        .post('/api/v1/disputes')
        .send(validBody(delivery._id.toString()));

      expect(res.status).toBe(401);
    });
  });

  describe('403 - authorization errors', () => {
    it('returns 403 when the requester is not a participant of the delivery', async () => {
      process.env.JWT_SECRET = JWT_SECRET;

      const customer = await createUser();
      const stranger = await createUser();
      const delivery = await createDelivery({ userId: customer._id.toString() });
      const token = signToken(stranger._id.toString());

      const res = await request(app)
        .post('/api/v1/disputes')
        .set('Authorization', `Bearer ${token}`)
        .send(validBody(delivery._id.toString()));

      expect(res.status).toBe(403);
    });
  });

  describe('404 - not found', () => {
    it('returns 404 when the delivery does not exist', async () => {
      process.env.JWT_SECRET = JWT_SECRET;

      const customer = await createUser();
      const token = signToken(customer._id.toString());
      const nonExistentId = new mongoose.Types.ObjectId().toString();

      const res = await request(app)
        .post('/api/v1/disputes')
        .set('Authorization', `Bearer ${token}`)
        .send(validBody(nonExistentId));

      expect(res.status).toBe(404);
    });
  });

  describe('409 - conflict', () => {
    it('returns 409 when an unresolved dispute already exists for the delivery', async () => {
      process.env.JWT_SECRET = JWT_SECRET;

      const customer = await createUser();
      const delivery = await createDelivery({ userId: customer._id.toString() });
      const token = signToken(customer._id.toString());

      await request(app)
        .post('/api/v1/disputes')
        .set('Authorization', `Bearer ${token}`)
        .send(validBody(delivery._id.toString()));

      const res = await request(app)
        .post('/api/v1/disputes')
        .set('Authorization', `Bearer ${token}`)
        .send(validBody(delivery._id.toString()));

      expect(res.status).toBe(409);
    });
  });

  describe('422 - business rule violations', () => {
    it('returns 422 when the delivery is pending (not yet active)', async () => {
      process.env.JWT_SECRET = JWT_SECRET;

      const customer = await createUser();
      const delivery = await createDelivery({
        userId: customer._id.toString(),
        status: DeliveryStatus.PENDING,
      });
      const token = signToken(customer._id.toString());

      const res = await request(app)
        .post('/api/v1/disputes')
        .set('Authorization', `Bearer ${token}`)
        .send(validBody(delivery._id.toString()));

      expect(res.status).toBe(422);
    });

    it('returns 422 when the delivery is already completed', async () => {
      process.env.JWT_SECRET = JWT_SECRET;

      const customer = await createUser();
      const delivery = await createDelivery({
        userId: customer._id.toString(),
        status: DeliveryStatus.COMPLETED,
      });
      const token = signToken(customer._id.toString());

      const res = await request(app)
        .post('/api/v1/disputes')
        .set('Authorization', `Bearer ${token}`)
        .send(validBody(delivery._id.toString()));

      expect(res.status).toBe(422);
    });
  });
});

// ─── GET /api/v1/disputes/:id ──────────────────────────────────────────

describe('GET /api/v1/disputes/:id', () => {
  describe('200 - success', () => {
    it('returns a single dispute by ID', async () => {
      process.env.JWT_SECRET = JWT_SECRET;

      const customer = await createUser();
      const delivery = await createDelivery({ userId: customer._id.toString() });
      const token = signToken(customer._id.toString());

      const createRes = await request(app)
        .post('/api/v1/disputes')
        .set('Authorization', `Bearer ${token}`)
        .send(validBody(delivery._id.toString()));

      const disputeId = createRes.body.data.dispute._id;

      const res = await request(app)
        .get(`/api/v1/disputes/${disputeId}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.dispute._id).toBe(disputeId);
      expect(res.body.data.dispute.deliveryId).toBe(delivery._id.toString());
    });
  });

  describe('400 - validation errors', () => {
    it('returns 400 when dispute ID is not a valid ObjectId', async () => {
      process.env.JWT_SECRET = JWT_SECRET;
      const customer = await createUser();
      const token = signToken(customer._id.toString());

      const res = await request(app)
        .get('/api/v1/disputes/not-an-objectid')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(400);
    });
  });

  describe('401 - authentication errors', () => {
    it('returns 401 when no Authorization header is provided', async () => {
      process.env.JWT_SECRET = JWT_SECRET;
      const customer = await createUser();
      const delivery = await createDelivery({ userId: customer._id.toString() });
      const token = signToken(customer._id.toString());

      const createRes = await request(app)
        .post('/api/v1/disputes')
        .set('Authorization', `Bearer ${token}`)
        .send(validBody(delivery._id.toString()));

      const disputeId = createRes.body.data.dispute._id;

      const res = await request(app).get(`/api/v1/disputes/${disputeId}`);

      expect(res.status).toBe(401);
    });
  });

  describe('404 - not found', () => {
    it('returns 404 when the dispute does not exist', async () => {
      process.env.JWT_SECRET = JWT_SECRET;
      const customer = await createUser();
      const token = signToken(customer._id.toString());
      const nonExistentId = new mongoose.Types.ObjectId().toString();

      const res = await request(app)
        .get(`/api/v1/disputes/${nonExistentId}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
    });
  });
});

// ─── GET /api/v1/disputes ──────────────────────────────────────────────

describe('GET /api/v1/disputes', () => {
  it('returns a paginated list of disputes', async () => {
    process.env.JWT_SECRET = JWT_SECRET;

    const customer = await createUser();
    const delivery = await createDelivery({ userId: customer._id.toString() });
    const token = signToken(customer._id.toString());

    await request(app)
      .post('/api/v1/disputes')
      .set('Authorization', `Bearer ${token}`)
      .send(validBody(delivery._id.toString()));

    const res = await request(app).get('/api/v1/disputes').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    expect(res.body.meta.total).toBeGreaterThanOrEqual(1);
  });

  it('filters disputes by status', async () => {
    process.env.JWT_SECRET = JWT_SECRET;

    const customer = await createUser();
    const delivery = await createDelivery({ userId: customer._id.toString() });
    const token = signToken(customer._id.toString());

    await request(app)
      .post('/api/v1/disputes')
      .set('Authorization', `Bearer ${token}`)
      .send(validBody(delivery._id.toString()));

    const res = await request(app)
      .get('/api/v1/disputes?status=open')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.every((d: { status: string }) => d.status === 'open')).toBe(true);
  });

  it('returns 400 for invalid status filter', async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    const customer = await createUser();
    const token = signToken(customer._id.toString());

    const res = await request(app)
      .get('/api/v1/disputes?status=invalid')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });
});

// ─── PATCH /api/v1/disputes/:id/resolve ────────────────────────────────

describe('PATCH /api/v1/disputes/:id/resolve', () => {
  describe('200 - success', () => {
    it('resolves a dispute with resolution notes', async () => {
      process.env.JWT_SECRET = JWT_SECRET;

      const customer = await createUser();
      const driver = await createUser({ role: UserRole.DRIVER });
      const delivery = await createDelivery({
        userId: customer._id.toString(),
        driverId: driver._id.toString(),
      });
      const token = signToken(customer._id.toString());

      const createRes = await request(app)
        .post('/api/v1/disputes')
        .set('Authorization', `Bearer ${token}`)
        .send(validBody(delivery._id.toString()));

      const disputeId = createRes.body.data.dispute._id;

      const res = await request(app)
        .patch(`/api/v1/disputes/${disputeId}/resolve`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          status: DisputeStatus.RESOLVED,
          resolutionNotes: 'The issue has been addressed and the customer has been compensated.',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.dispute.status).toBe('resolved');
      expect(res.body.data.dispute.resolutionNotes).toBe(
        'The issue has been addressed and the customer has been compensated.',
      );
      expect(res.body.data.dispute.resolvedAt).toBeDefined();
    });
  });

  describe('400 - validation errors', () => {
    it('returns 400 when resolutionNotes is too short', async () => {
      process.env.JWT_SECRET = JWT_SECRET;

      const customer = await createUser();
      const delivery = await createDelivery({ userId: customer._id.toString() });
      const token = signToken(customer._id.toString());

      const createRes = await request(app)
        .post('/api/v1/disputes')
        .set('Authorization', `Bearer ${token}`)
        .send(validBody(delivery._id.toString()));

      const disputeId = createRes.body.data.dispute._id;

      const res = await request(app)
        .patch(`/api/v1/disputes/${disputeId}/resolve`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          status: DisputeStatus.RESOLVED,
          resolutionNotes: 'too short',
        });

      expect(res.status).toBe(400);
    });

    it('returns 400 when status is invalid', async () => {
      process.env.JWT_SECRET = JWT_SECRET;

      const customer = await createUser();
      const delivery = await createDelivery({ userId: customer._id.toString() });
      const token = signToken(customer._id.toString());

      const createRes = await request(app)
        .post('/api/v1/disputes')
        .set('Authorization', `Bearer ${token}`)
        .send(validBody(delivery._id.toString()));

      const disputeId = createRes.body.data.dispute._id;

      const res = await request(app)
        .patch(`/api/v1/disputes/${disputeId}/resolve`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          status: 'invalid_status',
          resolutionNotes: 'A valid resolution note here.',
        });

      expect(res.status).toBe(400);
    });
  });

  describe('401 - authentication errors', () => {
    it('returns 401 when no Authorization header is provided', async () => {
      process.env.JWT_SECRET = JWT_SECRET;
      const customer = await createUser();
      const delivery = await createDelivery({ userId: customer._id.toString() });
      const token = signToken(customer._id.toString());

      const createRes = await request(app)
        .post('/api/v1/disputes')
        .set('Authorization', `Bearer ${token}`)
        .send(validBody(delivery._id.toString()));

      const disputeId = createRes.body.data.dispute._id;

      const res = await request(app).patch(`/api/v1/disputes/${disputeId}/resolve`).send({
        status: DisputeStatus.RESOLVED,
        resolutionNotes: 'Some resolution.',
      });

      expect(res.status).toBe(401);
    });
  });

  describe('404 - not found', () => {
    it('returns 404 when the dispute does not exist', async () => {
      process.env.JWT_SECRET = JWT_SECRET;
      const customer = await createUser();
      const token = signToken(customer._id.toString());
      const nonExistentId = new mongoose.Types.ObjectId().toString();

      const res = await request(app)
        .patch(`/api/v1/disputes/${nonExistentId}/resolve`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          status: DisputeStatus.RESOLVED,
          resolutionNotes: 'Some resolution.',
        });

      expect(res.status).toBe(404);
    });
  });

  describe('409 - conflict', () => {
    it('returns 409 when resolving an already resolved dispute', async () => {
      process.env.JWT_SECRET = JWT_SECRET;

      const customer = await createUser();
      const delivery = await createDelivery({ userId: customer._id.toString() });
      const token = signToken(customer._id.toString());

      const createRes = await request(app)
        .post('/api/v1/disputes')
        .set('Authorization', `Bearer ${token}`)
        .send(validBody(delivery._id.toString()));

      const disputeId = createRes.body.data.dispute._id;

      await request(app)
        .patch(`/api/v1/disputes/${disputeId}/resolve`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          status: DisputeStatus.RESOLVED,
          resolutionNotes: 'First resolution.',
        });

      const res = await request(app)
        .patch(`/api/v1/disputes/${disputeId}/resolve`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          status: DisputeStatus.RESOLVED,
          resolutionNotes: 'Second resolution.',
        });

      expect(res.status).toBe(409);
    });
  });
});

// ─── PATCH /api/v1/disputes/:id/evidence ───────────────────────────────

describe('PATCH /api/v1/disputes/:id/evidence', () => {
  describe('200 - success', () => {
    it('adds evidence URLs to an open dispute', async () => {
      process.env.JWT_SECRET = JWT_SECRET;

      const customer = await createUser();
      const delivery = await createDelivery({ userId: customer._id.toString() });
      const token = signToken(customer._id.toString());

      const createRes = await request(app)
        .post('/api/v1/disputes')
        .set('Authorization', `Bearer ${token}`)
        .send(validBody(delivery._id.toString()));

      const disputeId = createRes.body.data.dispute._id;

      const res = await request(app)
        .patch(`/api/v1/disputes/${disputeId}/evidence`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          evidenceUrls: ['https://example.com/evidence1.jpg', 'https://example.com/evidence2.jpg'],
        });

      expect(res.status).toBe(200);
      expect(res.body.data.dispute.evidenceUrls).toHaveLength(2);
      expect(res.body.data.dispute.evidenceUrls).toContain('https://example.com/evidence1.jpg');
    });

    it('does not duplicate existing evidence URLs', async () => {
      process.env.JWT_SECRET = JWT_SECRET;

      const customer = await createUser();
      const delivery = await createDelivery({ userId: customer._id.toString() });
      const token = signToken(customer._id.toString());

      const createRes = await request(app)
        .post('/api/v1/disputes')
        .set('Authorization', `Bearer ${token}`)
        .send({
          ...validBody(delivery._id.toString()),
          evidenceUrls: ['https://example.com/evidence1.jpg'],
        });

      const disputeId = createRes.body.data.dispute._id;

      const res = await request(app)
        .patch(`/api/v1/disputes/${disputeId}/evidence`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          evidenceUrls: ['https://example.com/evidence1.jpg', 'https://example.com/evidence2.jpg'],
        });

      expect(res.status).toBe(200);
      expect(res.body.data.dispute.evidenceUrls).toHaveLength(2);
    });
  });

  describe('400 - validation errors', () => {
    it('returns 400 when evidenceUrls is empty', async () => {
      process.env.JWT_SECRET = JWT_SECRET;

      const customer = await createUser();
      const delivery = await createDelivery({ userId: customer._id.toString() });
      const token = signToken(customer._id.toString());

      const createRes = await request(app)
        .post('/api/v1/disputes')
        .set('Authorization', `Bearer ${token}`)
        .send(validBody(delivery._id.toString()));

      const disputeId = createRes.body.data.dispute._id;

      const res = await request(app)
        .patch(`/api/v1/disputes/${disputeId}/evidence`)
        .set('Authorization', `Bearer ${token}`)
        .send({ evidenceUrls: [] });

      expect(res.status).toBe(400);
    });
  });

  describe('404 - not found', () => {
    it('returns 404 when the dispute does not exist', async () => {
      process.env.JWT_SECRET = JWT_SECRET;
      const customer = await createUser();
      const token = signToken(customer._id.toString());
      const nonExistentId = new mongoose.Types.ObjectId().toString();

      const res = await request(app)
        .patch(`/api/v1/disputes/${nonExistentId}/evidence`)
        .set('Authorization', `Bearer ${token}`)
        .send({ evidenceUrls: ['https://example.com/evidence1.jpg'] });

      expect(res.status).toBe(404);
    });
  });

  describe('409 - conflict', () => {
    it('returns 409 when adding evidence to a resolved dispute', async () => {
      process.env.JWT_SECRET = JWT_SECRET;

      const customer = await createUser();
      const delivery = await createDelivery({ userId: customer._id.toString() });
      const token = signToken(customer._id.toString());

      const createRes = await request(app)
        .post('/api/v1/disputes')
        .set('Authorization', `Bearer ${token}`)
        .send(validBody(delivery._id.toString()));

      const disputeId = createRes.body.data.dispute._id;

      await request(app)
        .patch(`/api/v1/disputes/${disputeId}/resolve`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          status: DisputeStatus.RESOLVED,
          resolutionNotes: 'The issue has been resolved.',
        });

      const res = await request(app)
        .patch(`/api/v1/disputes/${disputeId}/evidence`)
        .set('Authorization', `Bearer ${token}`)
        .send({ evidenceUrls: ['https://example.com/evidence1.jpg'] });

      expect(res.status).toBe(409);
    });
  });
});

// ─── PATCH /api/v1/disputes/:id ────────────────────────────────────────

describe('PATCH /api/v1/disputes/:id', () => {
  describe('200 - success', () => {
    it('updates dispute metadata', async () => {
      process.env.JWT_SECRET = JWT_SECRET;

      const customer = await createUser();
      const delivery = await createDelivery({ userId: customer._id.toString() });
      const token = signToken(customer._id.toString());

      const createRes = await request(app)
        .post('/api/v1/disputes')
        .set('Authorization', `Bearer ${token}`)
        .send(validBody(delivery._id.toString()));

      const disputeId = createRes.body.data.dispute._id;

      const res = await request(app)
        .patch(`/api/v1/disputes/${disputeId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          description: 'Updated description with more details about the damage.',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.dispute.description).toBe(
        'Updated description with more details about the damage.',
      );
    });
  });

  describe('400 - validation errors', () => {
    it('returns 400 when description is too short', async () => {
      process.env.JWT_SECRET = JWT_SECRET;

      const customer = await createUser();
      const delivery = await createDelivery({ userId: customer._id.toString() });
      const token = signToken(customer._id.toString());

      const createRes = await request(app)
        .post('/api/v1/disputes')
        .set('Authorization', `Bearer ${token}`)
        .send(validBody(delivery._id.toString()));

      const disputeId = createRes.body.data.dispute._id;

      const res = await request(app)
        .patch(`/api/v1/disputes/${disputeId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ description: 'too short' });

      expect(res.status).toBe(400);
    });
  });

  describe('404 - not found', () => {
    it('returns 404 when the dispute does not exist', async () => {
      process.env.JWT_SECRET = JWT_SECRET;
      const customer = await createUser();
      const token = signToken(customer._id.toString());
      const nonExistentId = new mongoose.Types.ObjectId().toString();

      const res = await request(app)
        .patch(`/api/v1/disputes/${nonExistentId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ description: 'Updated description.' });

      expect(res.status).toBe(404);
    });
  });

  describe('409 - conflict', () => {
    it('returns 409 when updating a resolved dispute', async () => {
      process.env.JWT_SECRET = JWT_SECRET;

      const customer = await createUser();
      const delivery = await createDelivery({ userId: customer._id.toString() });
      const token = signToken(customer._id.toString());

      const createRes = await request(app)
        .post('/api/v1/disputes')
        .set('Authorization', `Bearer ${token}`)
        .send(validBody(delivery._id.toString()));

      const disputeId = createRes.body.data.dispute._id;

      await request(app)
        .patch(`/api/v1/disputes/${disputeId}/resolve`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          status: DisputeStatus.RESOLVED,
          resolutionNotes: 'The issue has been resolved.',
        });

      const res = await request(app)
        .patch(`/api/v1/disputes/${disputeId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ description: 'Trying to update resolved dispute.' });

      expect(res.status).toBe(409);
    });
  });
});
