/**
 * Integration tests for the fleet routes (/api/v1/fleets).
 *
 * Drives the real Express app, the real JWT authenticate and role middleware,
 * and the real MongoDB models through an in-memory server. Covers member
 * management rules, treasury address validation, and an end-to-end invite
 * -> accept -> metrics flow that the unit-level fleet suite does not exercise.
 */

import request from 'supertest';
import mongoose, { Types } from 'mongoose';
import jwt from 'jsonwebtoken';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../../src/app';
import User from '../../src/models/User';
import Fleet from '../../src/models/Fleet';
import { UserRole, UserStatus } from '../../src/interfaces/IUser';

jest.mock('../../src/config/database', () => ({
  connectDatabase: jest.fn(),
}));

jest.mock('../../src/config/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

// ─── In-memory MongoDB ─────────────────────────────────────────────────────────

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await Fleet.init();
}, 120_000);

afterEach(async () => {
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    await collections[key].deleteMany({});
  }
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

// ─── Helpers ───────────────────────────────────────────────────────────────────

const JWT_SECRET = 'test-secret-key-16chars';

beforeEach(() => {
  process.env.JWT_SECRET = JWT_SECRET;
});

const signToken = (userId: string): string => jwt.sign({ userId }, JWT_SECRET, { expiresIn: '1h' });

let userSequence = 0;

const createUser = async (role: UserRole): Promise<InstanceType<typeof User>> => {
  userSequence += 1;
  return User.create({
    firstName: 'Test',
    lastName: 'User',
    email: `fleet-integration-${userSequence}@example.com`,
    password: 'Password123!',
    role,
    status: UserStatus.ACTIVE,
  });
};

let treasurySequence = 0;

/** Unique, format-valid treasury address (the treasury index is unique). */
const newTreasuryAddress = (): string => `G${String(++treasurySequence).padStart(55, '0')}`;

const BUSINESS_METADATA = { companyName: 'Integration Logistics', contactEmail: 'ops@example.com' };

const createFleetViaApi = async (
  ownerToken: string,
  name = 'Integration Fleet',
): Promise<string> => {
  const res = await request(app)
    .post('/api/v1/fleets')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ name, treasuryAddress: newTreasuryAddress(), businessMetadata: BUSINESS_METADATA });

  expect(res.status).toBe(201);
  return res.body.data.fleet._id as string;
};

// ─── Treasury address validation ───────────────────────────────────────────────

describe('POST /api/v1/fleets – treasury address validation', () => {
  it.each([
    ['lowercase prefix', `g${'A'.repeat(55)}`],
    ['wrong prefix', `S${'A'.repeat(55)}`],
    ['too short', `G${'A'.repeat(54)}`],
    ['too long', `G${'A'.repeat(56)}`],
    ['illegal characters', `G${'a'.repeat(55)}`],
    ['non-alphanumeric', `G${'-'.repeat(55)}`],
  ])('returns 400 for a treasury address with %s', async (_label, treasuryAddress) => {
    const owner = await createUser(UserRole.ENTERPRISE);

    const res = await request(app)
      .post('/api/v1/fleets')
      .set('Authorization', `Bearer ${signToken(owner._id.toString())}`)
      .send({ name: 'Bad Treasury', treasuryAddress, businessMetadata: BUSINESS_METADATA });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/valid Stellar public key/);
    expect(await Fleet.countDocuments({})).toBe(0);
  });

  it('accepts a treasury address in the Stellar public-key format and persists it trimmed', async () => {
    const owner = await createUser(UserRole.ENTERPRISE);
    const treasuryAddress = newTreasuryAddress();

    const res = await request(app)
      .post('/api/v1/fleets')
      .set('Authorization', `Bearer ${signToken(owner._id.toString())}`)
      .send({
        name: 'Good Treasury',
        treasuryAddress: `  ${treasuryAddress}  `,
        businessMetadata: BUSINESS_METADATA,
      });

    expect(res.status).toBe(201);
    const stored = await Fleet.findById(res.body.data.fleet._id).lean();
    expect(stored?.treasuryAddress).toBe(treasuryAddress);
  });
});

// ─── Member management ─────────────────────────────────────────────────────────

describe('POST /api/v1/fleets/:id/members', () => {
  it('lets the owner add a driver, which is the default role', async () => {
    const owner = await createUser(UserRole.ENTERPRISE);
    const driver = await createUser(UserRole.DRIVER);
    const fleetId = await createFleetViaApi(signToken(owner._id.toString()));

    const res = await request(app)
      .post(`/api/v1/fleets/${fleetId}/members`)
      .set('Authorization', `Bearer ${signToken(owner._id.toString())}`)
      .send({ userId: driver._id.toString() });

    expect(res.status).toBe(201);
    const stored = await Fleet.findById(fleetId).lean();
    const added = stored?.members.find((m) => m.userId.toString() === driver._id.toString());
    expect(added?.role).toBe('driver');
  });

  it('lets the owner add a member with an explicit viewer role', async () => {
    const owner = await createUser(UserRole.ENTERPRISE);
    const viewer = await createUser(UserRole.USER);
    const fleetId = await createFleetViaApi(signToken(owner._id.toString()));

    const res = await request(app)
      .post(`/api/v1/fleets/${fleetId}/members`)
      .set('Authorization', `Bearer ${signToken(owner._id.toString())}`)
      .send({ userId: viewer._id.toString(), role: 'viewer' });

    expect(res.status).toBe(201);
    const stored = await Fleet.findById(fleetId).lean();
    const added = stored?.members.find((m) => m.userId.toString() === viewer._id.toString());
    expect(added?.role).toBe('viewer');
  });

  it('returns 400 for a role outside the admin/driver/viewer set', async () => {
    const owner = await createUser(UserRole.ENTERPRISE);
    const driver = await createUser(UserRole.DRIVER);
    const fleetId = await createFleetViaApi(signToken(owner._id.toString()));

    const res = await request(app)
      .post(`/api/v1/fleets/${fleetId}/members`)
      .set('Authorization', `Bearer ${signToken(owner._id.toString())}`)
      .send({ userId: driver._id.toString(), role: 'superuser' });

    expect(res.status).toBe(400);
    const stored = await Fleet.findById(fleetId).lean();
    expect(stored?.members.some((m) => m.userId.toString() === driver._id.toString())).toBe(false);
  });

  it('returns 409 when the user is already a member', async () => {
    const owner = await createUser(UserRole.ENTERPRISE);
    const fleetId = await createFleetViaApi(signToken(owner._id.toString()));

    const res = await request(app)
      .post(`/api/v1/fleets/${fleetId}/members`)
      .set('Authorization', `Bearer ${signToken(owner._id.toString())}`)
      .send({ userId: owner._id.toString() });

    expect(res.status).toBe(409);
  });

  it('returns 403 when an enterprise user who does not own the fleet tries to add a member', async () => {
    const owner = await createUser(UserRole.ENTERPRISE);
    const otherEnterprise = await createUser(UserRole.ENTERPRISE);
    const driver = await createUser(UserRole.DRIVER);
    const fleetId = await createFleetViaApi(signToken(owner._id.toString()));

    const res = await request(app)
      .post(`/api/v1/fleets/${fleetId}/members`)
      .set('Authorization', `Bearer ${signToken(otherEnterprise._id.toString())}`)
      .send({ userId: driver._id.toString() });

    expect(res.status).toBe(403);
  });

  it('returns 403 when a driver tries to add a member', async () => {
    const owner = await createUser(UserRole.ENTERPRISE);
    const driver = await createUser(UserRole.DRIVER);
    const fleetId = await createFleetViaApi(signToken(owner._id.toString()));

    const res = await request(app)
      .post(`/api/v1/fleets/${fleetId}/members`)
      .set('Authorization', `Bearer ${signToken(driver._id.toString())}`)
      .send({ userId: driver._id.toString() });

    expect(res.status).toBe(403);
  });

  it('returns 400 for malformed fleet or user ids', async () => {
    const owner = await createUser(UserRole.ENTERPRISE);
    const token = signToken(owner._id.toString());
    const fleetId = await createFleetViaApi(token);

    const badUser = await request(app)
      .post(`/api/v1/fleets/${fleetId}/members`)
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: 'not-an-id' });
    const badFleet = await request(app)
      .post('/api/v1/fleets/not-an-id/members')
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: owner._id.toString() });

    expect(badUser.status).toBe(400);
    expect(badFleet.status).toBe(400);
  });

  it('returns 404 for an unknown user and for an unknown fleet', async () => {
    const owner = await createUser(UserRole.ENTERPRISE);
    const token = signToken(owner._id.toString());
    const fleetId = await createFleetViaApi(token);
    const missingUserId = new Types.ObjectId().toHexString();

    const unknownUser = await request(app)
      .post(`/api/v1/fleets/${fleetId}/members`)
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: missingUserId });
    const unknownFleet = await request(app)
      .post(`/api/v1/fleets/${new Types.ObjectId().toHexString()}/members`)
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: owner._id.toString() });

    expect(unknownUser.status).toBe(404);
    expect(unknownFleet.status).toBe(404);
  });
});

describe('DELETE /api/v1/fleets/:id/members/:userId', () => {
  it('lets the owner remove a member and only that member', async () => {
    const owner = await createUser(UserRole.ENTERPRISE);
    const token = signToken(owner._id.toString());
    const driverA = await createUser(UserRole.DRIVER);
    const driverB = await createUser(UserRole.DRIVER);
    const fleetId = await createFleetViaApi(token);
    for (const driver of [driverA, driverB]) {
      await request(app)
        .post(`/api/v1/fleets/${fleetId}/members`)
        .set('Authorization', `Bearer ${token}`)
        .send({ userId: driver._id.toString() });
    }

    const res = await request(app)
      .delete(`/api/v1/fleets/${fleetId}/members/${driverA._id.toString()}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const stored = await Fleet.findById(fleetId).lean();
    const remainingIds = stored?.members.map((m) => m.userId.toString()) ?? [];
    expect(remainingIds).not.toContain(driverA._id.toString());
    expect(remainingIds).toContain(driverB._id.toString());
    expect(remainingIds).toContain(owner._id.toString());
  });

  it('returns 400 when the owner tries to remove themselves', async () => {
    const owner = await createUser(UserRole.ENTERPRISE);
    const token = signToken(owner._id.toString());
    const fleetId = await createFleetViaApi(token);

    const res = await request(app)
      .delete(`/api/v1/fleets/${fleetId}/members/${owner._id.toString()}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
  });

  it('returns 404 when the user is not a member of the fleet', async () => {
    const owner = await createUser(UserRole.ENTERPRISE);
    const token = signToken(owner._id.toString());
    const stranger = await createUser(UserRole.DRIVER);
    const fleetId = await createFleetViaApi(token);

    const res = await request(app)
      .delete(`/api/v1/fleets/${fleetId}/members/${stranger._id.toString()}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });

  it('returns 403 when a non-owner tries to remove a member', async () => {
    const owner = await createUser(UserRole.ENTERPRISE);
    const otherEnterprise = await createUser(UserRole.ENTERPRISE);
    const driver = await createUser(UserRole.DRIVER);
    const token = signToken(owner._id.toString());
    const fleetId = await createFleetViaApi(token);
    await request(app)
      .post(`/api/v1/fleets/${fleetId}/members`)
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: driver._id.toString() });

    const res = await request(app)
      .delete(`/api/v1/fleets/${fleetId}/members/${driver._id.toString()}`)
      .set('Authorization', `Bearer ${signToken(otherEnterprise._id.toString())}`);

    expect(res.status).toBe(403);
    const stored = await Fleet.findById(fleetId).lean();
    expect(stored?.members.some((m) => m.userId.toString() === driver._id.toString())).toBe(true);
  });
});

// ─── Fleet lookup ──────────────────────────────────────────────────────────────

describe('GET /api/v1/fleets/:id', () => {
  it('returns the fleet with its owner and members populated', async () => {
    const owner = await createUser(UserRole.ENTERPRISE);
    const token = signToken(owner._id.toString());
    const fleetId = await createFleetViaApi(token, 'Lookup Fleet');

    const res = await request(app)
      .get(`/api/v1/fleets/${fleetId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.fleet.name).toBe('Lookup Fleet');
    expect(res.body.data.fleet.ownerId.email).toBe(owner.email);
  });

  it('returns 400 for a malformed id and 404 for an unknown fleet', async () => {
    const owner = await createUser(UserRole.ENTERPRISE);
    const token = signToken(owner._id.toString());

    const malformed = await request(app)
      .get('/api/v1/fleets/not-an-id')
      .set('Authorization', `Bearer ${token}`);
    const missing = await request(app)
      .get(`/api/v1/fleets/${new Types.ObjectId().toHexString()}`)
      .set('Authorization', `Bearer ${token}`);

    expect(malformed.status).toBe(400);
    expect(missing.status).toBe(404);
  });
});

// ─── End-to-end invite flow ────────────────────────────────────────────────────

describe('fleet invite lifecycle end to end', () => {
  it('invite -> accept adds the driver, which the metrics endpoint then counts', async () => {
    const owner = await createUser(UserRole.ENTERPRISE);
    const driver = await createUser(UserRole.DRIVER);
    const ownerToken = signToken(owner._id.toString());
    const driverToken = signToken(driver._id.toString());
    const fleetId = await createFleetViaApi(ownerToken);

    const invite = await request(app)
      .post(`/api/v1/fleets/${fleetId}/invite`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ driverId: driver._id.toString() });
    expect(invite.status).toBe(201);
    const invitationId = invite.body.data.invitation._id as string;

    const accept = await request(app)
      .patch(`/api/v1/fleets/invitations/${invitationId}`)
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ accept: true });
    expect(accept.status).toBe(200);

    const metrics = await request(app)
      .get(`/api/v1/fleets/${fleetId}/metrics`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(metrics.status).toBe(200);
    expect(metrics.body.data.metrics.driverCount).toBe(1);
  });

  it('invite -> decline leaves the fleet without the driver', async () => {
    const owner = await createUser(UserRole.ENTERPRISE);
    const driver = await createUser(UserRole.DRIVER);
    const ownerToken = signToken(owner._id.toString());
    const fleetId = await createFleetViaApi(ownerToken);

    const invite = await request(app)
      .post(`/api/v1/fleets/${fleetId}/invite`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ driverId: driver._id.toString() });
    const invitationId = invite.body.data.invitation._id as string;

    const decline = await request(app)
      .patch(`/api/v1/fleets/invitations/${invitationId}`)
      .set('Authorization', `Bearer ${signToken(driver._id.toString())}`)
      .send({ accept: false });
    expect(decline.status).toBe(200);

    const stored = await Fleet.findById(fleetId).lean();
    expect(stored?.drivers.map((d) => d.toString())).not.toContain(driver._id.toString());
  });
});
