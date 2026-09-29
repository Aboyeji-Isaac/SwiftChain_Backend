import request from 'supertest';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import User from '../src/models/User';
import Fleet from '../src/models/Fleet';
import FleetInvitation from '../src/models/FleetInvitation';
import Delivery from '../src/models/Delivery';
import { UserRole, UserStatus } from '../src/interfaces/IUser';
import { FleetInvitationStatus } from '../src/interfaces/IFleet';

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

const signToken = (userId: string): string => jwt.sign({ userId }, JWT_SECRET, { expiresIn: '1h' });

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

// ─── POST /api/v1/fleets ───────────────────────────────────────────────────────

describe('POST /api/v1/fleets', () => {
  describe('201 – successful creation', () => {
    it('creates a fleet for an enterprise user', async () => {
      const owner = await createUser({ role: UserRole.ENTERPRISE });
      const token = signToken(owner._id.toString());

      const res = await request(app)
        .post('/api/v1/fleets')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'City Logistics Fleet' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.fleet.name).toBe('City Logistics Fleet');
    });

    it('persists the fleet to the database with the correct owner', async () => {
      const owner = await createUser({ role: UserRole.ENTERPRISE });
      const token = signToken(owner._id.toString());

      await request(app)
        .post('/api/v1/fleets')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Persisted Fleet' });

      const fleet = await Fleet.findOne({ name: 'Persisted Fleet' });
      expect(fleet).not.toBeNull();
      expect(fleet?.ownerId.toString()).toBe(owner._id.toString());
      expect(fleet?.drivers).toEqual([]);
    });

    it('trims whitespace from the fleet name', async () => {
      const owner = await createUser({ role: UserRole.ENTERPRISE });
      const token = signToken(owner._id.toString());

      const res = await request(app)
        .post('/api/v1/fleets')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: '  Trimmed Fleet  ' });

      expect(res.body.data.fleet.name).toBe('Trimmed Fleet');
    });
  });

  describe('400 – validation errors', () => {
    it('returns 400 when name is missing', async () => {
      const owner = await createUser({ role: UserRole.ENTERPRISE });
      const token = signToken(owner._id.toString());

      const res = await request(app)
        .post('/api/v1/fleets')
        .set('Authorization', `Bearer ${token}`)
        .send({});

      expect(res.status).toBe(400);
    });

    it('returns 400 when name is a single character', async () => {
      const owner = await createUser({ role: UserRole.ENTERPRISE });
      const token = signToken(owner._id.toString());

      const res = await request(app)
        .post('/api/v1/fleets')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'A' });

      expect(res.status).toBe(400);
    });
  });

  describe('401 – authentication errors', () => {
    it('returns 401 when no Authorization header is provided', async () => {
      const res = await request(app).post('/api/v1/fleets').send({ name: 'No Auth Fleet' });
      expect(res.status).toBe(401);
    });
  });

  describe('403 – authorisation errors', () => {
    it('returns 403 when a regular user tries to create a fleet', async () => {
      const user = await createUser({ role: UserRole.USER });
      const token = signToken(user._id.toString());

      const res = await request(app)
        .post('/api/v1/fleets')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Unauthorized Fleet' });

      expect(res.status).toBe(403);
    });

    it('returns 403 when a driver tries to create a fleet', async () => {
      const driver = await createUser({ role: UserRole.DRIVER });
      const token = signToken(driver._id.toString());

      const res = await request(app)
        .post('/api/v1/fleets')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Driver Fleet' });

      expect(res.status).toBe(403);
    });
  });

  describe('409 – conflict', () => {
    it('returns 409 when the owner already has a fleet with the same name', async () => {
      const owner = await createUser({ role: UserRole.ENTERPRISE });
      const token = signToken(owner._id.toString());

      await request(app)
        .post('/api/v1/fleets')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Duplicate Fleet' });

      const res = await request(app)
        .post('/api/v1/fleets')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Duplicate Fleet' });

      expect(res.status).toBe(409);
    });

    it('allows two different owners to use the same fleet name', async () => {
      const ownerA = await createUser({ role: UserRole.ENTERPRISE });
      const ownerB = await createUser({ role: UserRole.ENTERPRISE });
      const tokenA = signToken(ownerA._id.toString());
      const tokenB = signToken(ownerB._id.toString());

      const resA = await request(app)
        .post('/api/v1/fleets')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Shared Name Fleet' });
      const resB = await request(app)
        .post('/api/v1/fleets')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ name: 'Shared Name Fleet' });

      expect(resA.status).toBe(201);
      expect(resB.status).toBe(201);
    });
  });
});

// ─── POST /api/v1/fleets/:id/invite ────────────────────────────────────────────

describe('POST /api/v1/fleets/:id/invite', () => {
  describe('201 – successful invitation', () => {
    it('invites a driver to the fleet', async () => {
      const owner = await createUser({ role: UserRole.ENTERPRISE });
      const driver = await createUser({ role: UserRole.DRIVER });
      const token = signToken(owner._id.toString());
      const fleet = await Fleet.create({ name: 'Invite Fleet', ownerId: owner._id });

      const res = await request(app)
        .post(`/api/v1/fleets/${fleet._id}/invite`)
        .set('Authorization', `Bearer ${token}`)
        .send({ driverId: driver._id.toString() });

      expect(res.status).toBe(201);
      expect(res.body.data.invitation.status).toBe(FleetInvitationStatus.PENDING);
    });

    it('persists the invitation to the database', async () => {
      const owner = await createUser({ role: UserRole.ENTERPRISE });
      const driver = await createUser({ role: UserRole.DRIVER });
      const token = signToken(owner._id.toString());
      const fleet = await Fleet.create({ name: 'Persisted Invite Fleet', ownerId: owner._id });

      await request(app)
        .post(`/api/v1/fleets/${fleet._id}/invite`)
        .set('Authorization', `Bearer ${token}`)
        .send({ driverId: driver._id.toString() });

      const invitation = await FleetInvitation.findOne({
        fleetId: fleet._id,
        driverId: driver._id,
      });
      expect(invitation).not.toBeNull();
      expect(invitation?.invitedBy.toString()).toBe(owner._id.toString());
    });
  });

  describe('400 – validation errors', () => {
    it('returns 400 when driverId is missing', async () => {
      const owner = await createUser({ role: UserRole.ENTERPRISE });
      const token = signToken(owner._id.toString());
      const fleet = await Fleet.create({ name: 'No Driver Fleet', ownerId: owner._id });

      const res = await request(app)
        .post(`/api/v1/fleets/${fleet._id}/invite`)
        .set('Authorization', `Bearer ${token}`)
        .send({});

      expect(res.status).toBe(400);
    });

    it('returns 400 when driverId is not a valid ObjectId', async () => {
      const owner = await createUser({ role: UserRole.ENTERPRISE });
      const token = signToken(owner._id.toString());
      const fleet = await Fleet.create({ name: 'Bad Driver Id Fleet', ownerId: owner._id });

      const res = await request(app)
        .post(`/api/v1/fleets/${fleet._id}/invite`)
        .set('Authorization', `Bearer ${token}`)
        .send({ driverId: 'not-an-objectid' });

      expect(res.status).toBe(400);
    });
  });

  describe('403 – authorisation errors', () => {
    it("returns 403 when a non-owner enterprise user tries to invite to someone else's fleet", async () => {
      const owner = await createUser({ role: UserRole.ENTERPRISE });
      const otherEnterprise = await createUser({ role: UserRole.ENTERPRISE });
      const driver = await createUser({ role: UserRole.DRIVER });
      const token = signToken(otherEnterprise._id.toString());
      const fleet = await Fleet.create({ name: 'Owned By Someone Else', ownerId: owner._id });

      const res = await request(app)
        .post(`/api/v1/fleets/${fleet._id}/invite`)
        .set('Authorization', `Bearer ${token}`)
        .send({ driverId: driver._id.toString() });

      expect(res.status).toBe(403);
    });
  });

  describe('404 – not found', () => {
    it('returns 404 when the fleet does not exist', async () => {
      const owner = await createUser({ role: UserRole.ENTERPRISE });
      const driver = await createUser({ role: UserRole.DRIVER });
      const token = signToken(owner._id.toString());
      const nonExistentFleetId = new mongoose.Types.ObjectId().toString();

      const res = await request(app)
        .post(`/api/v1/fleets/${nonExistentFleetId}/invite`)
        .set('Authorization', `Bearer ${token}`)
        .send({ driverId: driver._id.toString() });

      expect(res.status).toBe(404);
    });

    it('returns 404 when the invited driver does not exist', async () => {
      const owner = await createUser({ role: UserRole.ENTERPRISE });
      const token = signToken(owner._id.toString());
      const fleet = await Fleet.create({ name: 'Ghost Driver Fleet', ownerId: owner._id });
      const nonExistentDriverId = new mongoose.Types.ObjectId().toString();

      const res = await request(app)
        .post(`/api/v1/fleets/${fleet._id}/invite`)
        .set('Authorization', `Bearer ${token}`)
        .send({ driverId: nonExistentDriverId });

      expect(res.status).toBe(404);
    });
  });

  describe('422 – business rule violations', () => {
    it('returns 422 when the invited user is not a driver', async () => {
      const owner = await createUser({ role: UserRole.ENTERPRISE });
      const notADriver = await createUser({ role: UserRole.USER });
      const token = signToken(owner._id.toString());
      const fleet = await Fleet.create({ name: 'Not A Driver Fleet', ownerId: owner._id });

      const res = await request(app)
        .post(`/api/v1/fleets/${fleet._id}/invite`)
        .set('Authorization', `Bearer ${token}`)
        .send({ driverId: notADriver._id.toString() });

      expect(res.status).toBe(422);
    });
  });

  describe('409 – conflict', () => {
    it('returns 409 when the driver already has a pending invitation', async () => {
      const owner = await createUser({ role: UserRole.ENTERPRISE });
      const driver = await createUser({ role: UserRole.DRIVER });
      const token = signToken(owner._id.toString());
      const fleet = await Fleet.create({ name: 'Double Invite Fleet', ownerId: owner._id });

      await request(app)
        .post(`/api/v1/fleets/${fleet._id}/invite`)
        .set('Authorization', `Bearer ${token}`)
        .send({ driverId: driver._id.toString() });

      const res = await request(app)
        .post(`/api/v1/fleets/${fleet._id}/invite`)
        .set('Authorization', `Bearer ${token}`)
        .send({ driverId: driver._id.toString() });

      expect(res.status).toBe(409);
    });

    it('returns 409 when the driver is already a fleet member', async () => {
      const owner = await createUser({ role: UserRole.ENTERPRISE });
      const driver = await createUser({ role: UserRole.DRIVER });
      const token = signToken(owner._id.toString());
      const fleet = await Fleet.create({
        name: 'Already Member Fleet',
        ownerId: owner._id,
        drivers: [driver._id],
      });

      const res = await request(app)
        .post(`/api/v1/fleets/${fleet._id}/invite`)
        .set('Authorization', `Bearer ${token}`)
        .send({ driverId: driver._id.toString() });

      expect(res.status).toBe(409);
    });
  });
});

// ─── PATCH /api/v1/fleets/invitations/:invitationId ────────────────────────────

describe('PATCH /api/v1/fleets/invitations/:invitationId', () => {
  describe('200 – accept', () => {
    it('accepts a pending invitation and adds the driver to the fleet', async () => {
      const owner = await createUser({ role: UserRole.ENTERPRISE });
      const driver = await createUser({ role: UserRole.DRIVER });
      const driverToken = signToken(driver._id.toString());
      const fleet = await Fleet.create({ name: 'Accept Fleet', ownerId: owner._id });
      const invitation = await FleetInvitation.create({
        fleetId: fleet._id,
        driverId: driver._id,
        invitedBy: owner._id,
      });

      const res = await request(app)
        .patch(`/api/v1/fleets/invitations/${invitation._id}`)
        .set('Authorization', `Bearer ${driverToken}`)
        .send({ accept: true });

      expect(res.status).toBe(200);
      expect(res.body.data.invitation.status).toBe(FleetInvitationStatus.ACCEPTED);

      const updatedFleet = await Fleet.findById(fleet._id);
      expect(updatedFleet?.drivers.map((id) => id.toString())).toContain(driver._id.toString());
    });
  });

  describe('200 – decline', () => {
    it('declines a pending invitation without adding the driver to the fleet', async () => {
      const owner = await createUser({ role: UserRole.ENTERPRISE });
      const driver = await createUser({ role: UserRole.DRIVER });
      const driverToken = signToken(driver._id.toString());
      const fleet = await Fleet.create({ name: 'Decline Fleet', ownerId: owner._id });
      const invitation = await FleetInvitation.create({
        fleetId: fleet._id,
        driverId: driver._id,
        invitedBy: owner._id,
      });

      const res = await request(app)
        .patch(`/api/v1/fleets/invitations/${invitation._id}`)
        .set('Authorization', `Bearer ${driverToken}`)
        .send({ accept: false });

      expect(res.status).toBe(200);
      expect(res.body.data.invitation.status).toBe(FleetInvitationStatus.DECLINED);

      const updatedFleet = await Fleet.findById(fleet._id);
      expect(updatedFleet?.drivers).toHaveLength(0);
    });
  });

  describe('400 – validation errors', () => {
    it('returns 400 when accept is not a boolean', async () => {
      const owner = await createUser({ role: UserRole.ENTERPRISE });
      const driver = await createUser({ role: UserRole.DRIVER });
      const driverToken = signToken(driver._id.toString());
      const fleet = await Fleet.create({ name: 'Bad Accept Fleet', ownerId: owner._id });
      const invitation = await FleetInvitation.create({
        fleetId: fleet._id,
        driverId: driver._id,
        invitedBy: owner._id,
      });

      const res = await request(app)
        .patch(`/api/v1/fleets/invitations/${invitation._id}`)
        .set('Authorization', `Bearer ${driverToken}`)
        .send({ accept: 'yes' });

      expect(res.status).toBe(400);
    });
  });

  describe('403 – authorisation errors', () => {
    it('returns 403 when a different driver tries to respond to the invitation', async () => {
      const owner = await createUser({ role: UserRole.ENTERPRISE });
      const driver = await createUser({ role: UserRole.DRIVER });
      const otherDriver = await createUser({ role: UserRole.DRIVER });
      const otherDriverToken = signToken(otherDriver._id.toString());
      const fleet = await Fleet.create({ name: 'Wrong Driver Fleet', ownerId: owner._id });
      const invitation = await FleetInvitation.create({
        fleetId: fleet._id,
        driverId: driver._id,
        invitedBy: owner._id,
      });

      const res = await request(app)
        .patch(`/api/v1/fleets/invitations/${invitation._id}`)
        .set('Authorization', `Bearer ${otherDriverToken}`)
        .send({ accept: true });

      expect(res.status).toBe(403);
    });

    it('returns 403 when an enterprise user tries to respond to an invitation', async () => {
      const owner = await createUser({ role: UserRole.ENTERPRISE });
      const driver = await createUser({ role: UserRole.DRIVER });
      const ownerToken = signToken(owner._id.toString());
      const fleet = await Fleet.create({ name: 'Enterprise Respond Fleet', ownerId: owner._id });
      const invitation = await FleetInvitation.create({
        fleetId: fleet._id,
        driverId: driver._id,
        invitedBy: owner._id,
      });

      const res = await request(app)
        .patch(`/api/v1/fleets/invitations/${invitation._id}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ accept: true });

      expect(res.status).toBe(403);
    });
  });

  describe('404 – not found', () => {
    it('returns 404 when the invitation does not exist', async () => {
      const driver = await createUser({ role: UserRole.DRIVER });
      const driverToken = signToken(driver._id.toString());
      const nonExistentInvitationId = new mongoose.Types.ObjectId().toString();

      const res = await request(app)
        .patch(`/api/v1/fleets/invitations/${nonExistentInvitationId}`)
        .set('Authorization', `Bearer ${driverToken}`)
        .send({ accept: true });

      expect(res.status).toBe(404);
    });
  });

  describe('409 – conflict', () => {
    it('returns 409 when responding to an already-accepted invitation', async () => {
      const owner = await createUser({ role: UserRole.ENTERPRISE });
      const driver = await createUser({ role: UserRole.DRIVER });
      const driverToken = signToken(driver._id.toString());
      const fleet = await Fleet.create({ name: 'Already Responded Fleet', ownerId: owner._id });
      const invitation = await FleetInvitation.create({
        fleetId: fleet._id,
        driverId: driver._id,
        invitedBy: owner._id,
        status: FleetInvitationStatus.ACCEPTED,
        respondedAt: new Date(),
      });

      const res = await request(app)
        .patch(`/api/v1/fleets/invitations/${invitation._id}`)
        .set('Authorization', `Bearer ${driverToken}`)
        .send({ accept: false });

      expect(res.status).toBe(409);
    });
  });
});

// ─── GET /api/v1/fleets/:id/metrics ─────────────────────────────────────────────

describe('GET /api/v1/fleets/:id/metrics', () => {
  describe('200 – successful metrics', () => {
    it('returns zeroed metrics for a fleet with no drivers', async () => {
      const owner = await createUser({ role: UserRole.ENTERPRISE });
      const token = signToken(owner._id.toString());
      const fleet = await Fleet.create({ name: 'Empty Fleet', ownerId: owner._id });

      const res = await request(app)
        .get(`/api/v1/fleets/${fleet._id}/metrics`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.metrics).toEqual({
        fleetId: fleet._id.toString(),
        driverCount: 0,
        totalDeliveries: 0,
        completedDeliveries: 0,
        totalEscrowValue: 0,
      });
    });

    it('aggregates delivery counts and escrow values across fleet drivers', async () => {
      const owner = await createUser({ role: UserRole.ENTERPRISE });
      const driverA = await createUser({ role: UserRole.DRIVER });
      const driverB = await createUser({ role: UserRole.DRIVER });
      const token = signToken(owner._id.toString());
      const fleet = await Fleet.create({
        name: 'Metrics Fleet',
        ownerId: owner._id,
        drivers: [driverA._id, driverB._id],
      });

      await Delivery.create({
        driverId: driverA._id.toString(),
        userId: 'customer-1',
        status: 'completed',
        escrowAmount: 100,
        pickupCoordinates: { lat: 0, lng: 0, address: 'a' },
        dropoffCoordinates: { lat: 1, lng: 1, address: 'b' },
      });
      await Delivery.create({
        driverId: driverA._id.toString(),
        userId: 'customer-2',
        status: 'in_progress',
        escrowAmount: 50,
        pickupCoordinates: { lat: 0, lng: 0, address: 'a' },
        dropoffCoordinates: { lat: 1, lng: 1, address: 'b' },
      });
      await Delivery.create({
        driverId: driverB._id.toString(),
        userId: 'customer-3',
        status: 'completed',
        escrowAmount: 75,
        pickupCoordinates: { lat: 0, lng: 0, address: 'a' },
        dropoffCoordinates: { lat: 1, lng: 1, address: 'b' },
      });
      // Delivery by a driver NOT in this fleet — must not be counted.
      const outsideDriver = await createUser({ role: UserRole.DRIVER });
      await Delivery.create({
        driverId: outsideDriver._id.toString(),
        userId: 'customer-4',
        status: 'completed',
        escrowAmount: 9999,
        pickupCoordinates: { lat: 0, lng: 0, address: 'a' },
        dropoffCoordinates: { lat: 1, lng: 1, address: 'b' },
      });

      const res = await request(app)
        .get(`/api/v1/fleets/${fleet._id}/metrics`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.metrics.driverCount).toBe(2);
      expect(res.body.data.metrics.totalDeliveries).toBe(3);
      expect(res.body.data.metrics.completedDeliveries).toBe(2);
      expect(res.body.data.metrics.totalEscrowValue).toBe(225);
    });
  });

  describe('403 – authorisation errors', () => {
    it('returns 403 when a non-owner tries to view fleet metrics', async () => {
      const owner = await createUser({ role: UserRole.ENTERPRISE });
      const otherEnterprise = await createUser({ role: UserRole.ENTERPRISE });
      const token = signToken(otherEnterprise._id.toString());
      const fleet = await Fleet.create({ name: 'Private Metrics Fleet', ownerId: owner._id });

      const res = await request(app)
        .get(`/api/v1/fleets/${fleet._id}/metrics`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
    });

    it('returns 403 when a driver tries to view fleet metrics', async () => {
      const owner = await createUser({ role: UserRole.ENTERPRISE });
      const driver = await createUser({ role: UserRole.DRIVER });
      const token = signToken(driver._id.toString());
      const fleet = await Fleet.create({ name: 'Driver Blocked Fleet', ownerId: owner._id });

      const res = await request(app)
        .get(`/api/v1/fleets/${fleet._id}/metrics`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
    });
  });

  describe('404 – not found', () => {
    it('returns 404 when the fleet does not exist', async () => {
      const owner = await createUser({ role: UserRole.ENTERPRISE });
      const token = signToken(owner._id.toString());
      const nonExistentFleetId = new mongoose.Types.ObjectId().toString();

      const res = await request(app)
        .get(`/api/v1/fleets/${nonExistentFleetId}/metrics`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
    });
  });
});
