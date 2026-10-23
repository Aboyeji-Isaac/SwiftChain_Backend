/**
 * Unit tests for AssignmentService — nearest-driver selection, radius
 * expansion, contention on the atomic driver claim, claim rollback, and the
 * auto-assignment sweep.
 *
 * Deliveries, escrows and driver positions are persisted in an in-memory
 * MongoDB, so the proximity search runs the real `$geoNear` pipeline against
 * the real 2dsphere indexes and the assignment goes through the real
 * `deliveryService.assignDriver` escrow guard. Only the Redis-backed Redlock
 * is replaced, by an in-process lock fake that records every acquire/release
 * and can be told to report contention for a resource.
 */

import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { StatusCodes } from 'http-status-codes';
import Delivery, { DeliveryStatus, IDelivery } from '../src/models/Delivery';
import Escrow, { EscrowStatus } from '../src/models/Escrow';
import { DriverLocation } from '../src/models/DriverLocation';
import { withLock } from '../src/config/redis';
import { driverLocationService } from '../src/services/driverLocationService';
import { AssignmentService } from '../src/services/assignmentService';
import env from '../src/config/env';
import AppError from '../src/utils/AppError';

jest.mock('../src/config/redis', () => ({
  withLock: jest.fn(),
}));

jest.mock('../src/config/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

// ─── Lock fake ──────────────────────────────────────────────────────────────────

/**
 * In-process stand-in for `withLock`: one holder per resource, released in a
 * `finally` exactly like the Redlock wrapper. A resource listed in
 * `contended` fails to acquire, as Redlock does once its retries run out.
 */
class FakeLock {
  readonly held = new Set<string>();
  readonly contended = new Set<string>();
  readonly acquired: string[] = [];
  readonly released: string[] = [];

  async run<T>(resource: string, fn: () => Promise<T>): Promise<T> {
    if (this.contended.has(resource) || this.held.has(resource)) {
      throw new Error(`[Redlock] Could not acquire lock for resource: ${resource}`);
    }
    this.held.add(resource);
    this.acquired.push(resource);
    try {
      return await fn();
    } finally {
      this.held.delete(resource);
      this.released.push(resource);
    }
  }
}

const mockedWithLock = withLock as jest.MockedFunction<typeof withLock>;
let lock: FakeLock;

// ─── Fixtures ───────────────────────────────────────────────────────────────────

/** Pickup point every delivery searches from (Lagos). */
const PICKUP = { lat: 6.5244, lng: 3.3792 };

/** Metres per degree of latitude on the WGS84 sphere MongoDB uses. */
const METRES_PER_DEGREE_LAT = 111_195;

/** A point `metres` due north of the pickup. */
const northOfPickup = (metres: number): { lat: number; lng: number } => ({
  lat: PICKUP.lat + metres / METRES_PER_DEGREE_LAT,
  lng: PICKUP.lng,
});

const placeDriver = async (
  metresAway: number,
  overrides: { isAvailable?: boolean; status?: 'online' | 'offline' | 'on_delivery' } = {},
): Promise<string> => {
  const driverId = new Types.ObjectId();
  const { lat, lng } = northOfPickup(metresAway);
  await DriverLocation.create({
    driverId,
    location: DriverLocation.toGeoPoint(lat, lng),
    isAvailable: overrides.isAvailable ?? true,
    status: overrides.status ?? 'online',
  });
  return String(driverId);
};

const createFundedDelivery = async (
  options: {
    escrowStatus?: EscrowStatus | null;
    withPickup?: boolean;
    status?: DeliveryStatus;
    driverId?: string;
    createdAt?: Date;
  } = {},
): Promise<IDelivery> => {
  const delivery = await Delivery.create({
    status: options.status ?? DeliveryStatus.FUNDED,
    driverId: options.driverId,
    pickupCoordinates: options.withPickup === false ? undefined : PICKUP,
    ...(options.createdAt ? { createdAt: options.createdAt } : {}),
  });

  const escrowStatus =
    options.escrowStatus === undefined ? EscrowStatus.LOCKED : options.escrowStatus;
  if (escrowStatus !== null) {
    await Escrow.create({
      delivery: delivery._id,
      status: escrowStatus,
      amount: 100,
      assetCode: 'XLM',
    });
  }

  return delivery;
};

const driverState = async (
  driverId: string,
): Promise<{ isAvailable: boolean; status: string; currentDeliveryId: unknown }> => {
  const doc = await DriverLocation.findOne({ driverId }).lean();
  if (!doc) throw new Error(`no DriverLocation for ${driverId}`);
  return {
    isAvailable: doc.isAvailable,
    status: doc.status,
    currentDeliveryId: doc.currentDeliveryId,
  };
};

// ─── Lifecycle ──────────────────────────────────────────────────────────────────

let mongoServer: MongoMemoryServer;
let service: AssignmentService;
const defaultExpansionSteps = env.ASSIGNMENT_RADIUS_EXPANSION_STEPS;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  // $geoNear needs the 2dsphere index to exist before the first query.
  await DriverLocation.syncIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(() => {
  lock = new FakeLock();
  mockedWithLock.mockReset();
  mockedWithLock.mockImplementation((resource, fn) => lock.run(resource, fn));
  service = new AssignmentService();
  env.ASSIGNMENT_RADIUS_EXPANSION_STEPS = defaultExpansionSteps;
});

afterEach(async () => {
  jest.restoreAllMocks();
  await Promise.all([
    Delivery.deleteMany({}),
    Escrow.deleteMany({}),
    DriverLocation.deleteMany({}),
  ]);
});

// ─── assignNearestDriver: selection ────────────────────────────────────────────

describe('AssignmentService.assignNearestDriver — nearest driver', () => {
  it('assigns the closest available driver and marks them on delivery', async () => {
    const far = await placeDriver(3_000);
    const nearest = await placeDriver(800);
    const middle = await placeDriver(1_500);
    const delivery = await createFundedDelivery();

    const result = await service.assignNearestDriver(String(delivery._id));

    expect(result.assigned).toBe(true);
    expect(result.driverId).toBe(nearest);
    expect(result.distanceMeters).toBeGreaterThan(700);
    expect(result.distanceMeters).toBeLessThan(900);
    expect(result.radiusMeters).toBe(env.DRIVER_PROXIMITY_DEFAULT_RADIUS_M);

    const stored = await Delivery.findById(delivery._id).lean();
    expect(stored?.driverId).toBe(nearest);
    expect(stored?.status).toBe(DeliveryStatus.ASSIGNED);

    expect(await driverState(nearest)).toMatchObject({ isAvailable: false, status: 'on_delivery' });
    // Only the winner is claimed; everyone else stays available.
    expect(await driverState(middle)).toMatchObject({ isAvailable: true, status: 'online' });
    expect(await driverState(far)).toMatchObject({ isAvailable: true, status: 'online' });
  });

  it('ignores closer drivers that are unavailable or offline', async () => {
    await placeDriver(200, { isAvailable: false, status: 'on_delivery' });
    await placeDriver(400, { isAvailable: true, status: 'offline' });
    const available = await placeDriver(2_000);
    const delivery = await createFundedDelivery();

    const result = await service.assignNearestDriver(String(delivery._id));

    expect(result.assigned).toBe(true);
    expect(result.driverId).toBe(available);
  });

  it('runs the whole assignment under a lock scoped to the delivery id and releases it', async () => {
    await placeDriver(500);
    const delivery = await createFundedDelivery();
    const resource = `assignment:delivery:${String(delivery._id)}`;

    await service.assignNearestDriver(String(delivery._id));

    expect(mockedWithLock).toHaveBeenCalledWith(resource, expect.any(Function));
    expect(lock.acquired).toEqual([resource]);
    expect(lock.released).toEqual([resource]);
    expect(lock.held.size).toBe(0);
  });
});

// ─── assignNearestDriver: radius expansion ─────────────────────────────────────

describe('AssignmentService.assignNearestDriver — radius expansion', () => {
  it('doubles the radius stepwise until a driver is in range', async () => {
    // Default base 5 km: 5 km and 10 km miss, 20 km finds the driver at 15 km.
    const driver = await placeDriver(15_000);
    const delivery = await createFundedDelivery();
    const search = jest.spyOn(driverLocationService, 'findNearbyDrivers');

    const result = await service.assignNearestDriver(String(delivery._id));

    const base = env.DRIVER_PROXIMITY_DEFAULT_RADIUS_M;
    expect(search.mock.calls.map(([q]) => q.radiusMeters)).toEqual([base, base * 2, base * 4]);
    expect(result).toMatchObject({ assigned: true, driverId: driver, radiusMeters: base * 4 });
  });

  it('stops after the configured number of expansion steps', async () => {
    env.ASSIGNMENT_RADIUS_EXPANSION_STEPS = 1;
    // Reachable at the third radius (20 km), but only one expansion is allowed.
    const driver = await placeDriver(15_000);
    const delivery = await createFundedDelivery();
    const search = jest.spyOn(driverLocationService, 'findNearbyDrivers');

    const result = await service.assignNearestDriver(String(delivery._id));

    const base = env.DRIVER_PROXIMITY_DEFAULT_RADIUS_M;
    expect(search.mock.calls.map(([q]) => q.radiusMeters)).toEqual([base, base * 2]);
    expect(result.assigned).toBe(false);
    expect(result.reason).toMatch(/No available driver/);
    expect(await driverState(driver)).toMatchObject({ isAvailable: true, status: 'online' });
  });

  it('never searches past DRIVER_PROXIMITY_MAX_RADIUS_M', async () => {
    env.ASSIGNMENT_RADIUS_EXPANSION_STEPS = 10;
    const delivery = await createFundedDelivery();
    const search = jest.spyOn(driverLocationService, 'findNearbyDrivers');

    const result = await service.assignNearestDriver(String(delivery._id));

    const radii = search.mock.calls.map(([q]) => q.radiusMeters ?? 0);
    expect(Math.max(...radii)).toBe(env.DRIVER_PROXIMITY_MAX_RADIUS_M);
    // Once the cap is searched the loop ends instead of repeating the cap.
    expect(radii.filter((r) => r === env.DRIVER_PROXIMITY_MAX_RADIUS_M)).toHaveLength(1);
    expect(result).toMatchObject({
      assigned: false,
      radiusMeters: env.DRIVER_PROXIMITY_MAX_RADIUS_M,
    });
  });

  it('leaves the delivery untouched when no driver is found', async () => {
    const delivery = await createFundedDelivery();

    const result = await service.assignNearestDriver(String(delivery._id));

    expect(result.assigned).toBe(false);
    const stored = await Delivery.findById(delivery._id).lean();
    expect(stored?.status).toBe(DeliveryStatus.FUNDED);
    expect(stored?.driverId).toBeUndefined();
  });
});

// ─── assignNearestDriver: contention ───────────────────────────────────────────

describe('AssignmentService.assignNearestDriver — claim contention', () => {
  it('skips a driver claimed by someone else between search and claim', async () => {
    const contested = await placeDriver(300);
    const runnerUp = await placeDriver(1_200);
    const delivery = await createFundedDelivery();

    // Another request claims the nearest driver after our search returned it
    // but before our atomic claim runs, so the search result is stale.
    const realSearch = driverLocationService.findNearbyDrivers.bind(driverLocationService);
    jest.spyOn(driverLocationService, 'findNearbyDrivers').mockImplementation(async (query) => {
      const result = await realSearch(query);
      await DriverLocation.updateOne(
        { driverId: contested },
        { $set: { isAvailable: false, status: 'on_delivery' } },
      );
      return result;
    });

    const result = await service.assignNearestDriver(String(delivery._id));

    expect(result.assigned).toBe(true);
    expect(result.driverId).toBe(runnerUp);
    // The contested driver was not re-claimed or assigned here.
    expect(await Delivery.countDocuments({ driverId: contested })).toBe(0);
  });

  it('never assigns one driver to two deliveries racing concurrently', async () => {
    const onlyDriver = await placeDriver(500);
    const first = await createFundedDelivery();
    const second = await createFundedDelivery();

    const results = await Promise.all([
      service.assignNearestDriver(String(first._id)),
      service.assignNearestDriver(String(second._id)),
    ]);

    expect(results.filter((r) => r.assigned)).toHaveLength(1);
    expect(results.filter((r) => !r.assigned)).toHaveLength(1);
    expect(await Delivery.countDocuments({ driverId: onlyDriver })).toBe(1);
  });

  it('rejects without touching any driver when the delivery lock is held', async () => {
    const driver = await placeDriver(500);
    const delivery = await createFundedDelivery();
    lock.contended.add(`assignment:delivery:${String(delivery._id)}`);

    await expect(service.assignNearestDriver(String(delivery._id))).rejects.toThrow(
      /Could not acquire lock/,
    );

    expect(await driverState(driver)).toMatchObject({ isAvailable: true, status: 'online' });
    expect((await Delivery.findById(delivery._id).lean())?.status).toBe(DeliveryStatus.FUNDED);
  });
});

// ─── releaseClaim ──────────────────────────────────────────────────────────────

describe('AssignmentService — claim release on a failed assignment', () => {
  it('releases the driver and the lock when the escrow guard rejects the assignment', async () => {
    const driver = await placeDriver(500);
    const delivery = await createFundedDelivery({ escrowStatus: EscrowStatus.PENDING });
    const resource = `assignment:delivery:${String(delivery._id)}`;

    await expect(service.assignNearestDriver(String(delivery._id))).rejects.toMatchObject({
      statusCode: StatusCodes.CONFLICT,
    });

    // The claimed driver is back online and was never attached to the delivery.
    expect(await driverState(driver)).toEqual({
      isAvailable: true,
      status: 'online',
      currentDeliveryId: null,
    });
    expect((await Delivery.findById(delivery._id).lean())?.driverId).toBeUndefined();
    expect(lock.released).toEqual([resource]);
    expect(lock.held.size).toBe(0);
  });

  it('releases the driver when the delivery has no escrow record at all', async () => {
    const driver = await placeDriver(500);
    const delivery = await createFundedDelivery({ escrowStatus: null });

    await expect(service.assignNearestDriver(String(delivery._id))).rejects.toMatchObject({
      statusCode: StatusCodes.UNPROCESSABLE_ENTITY,
    });

    expect(await driverState(driver)).toMatchObject({ isAvailable: true, status: 'online' });
  });

  it('still surfaces the original error when the release write itself fails', async () => {
    await placeDriver(500);
    const delivery = await createFundedDelivery({ escrowStatus: EscrowStatus.DISPUTED });

    // The claim succeeds (first call); the rollback write (second call) fails.
    const realUpdate = DriverLocation.findOneAndUpdate.bind(DriverLocation);
    let calls = 0;
    jest.spyOn(DriverLocation, 'findOneAndUpdate').mockImplementation(((
      ...args: Parameters<typeof DriverLocation.findOneAndUpdate>
    ): unknown => {
      calls += 1;
      if (calls === 2) {
        return { exec: () => Promise.reject(new Error('primary stepped down')) };
      }
      return realUpdate(...args);
    }) as unknown as typeof DriverLocation.findOneAndUpdate);

    await expect(service.assignNearestDriver(String(delivery._id))).rejects.toThrow(
      /under dispute/,
    );
    expect(calls).toBe(2);
    expect(lock.held.size).toBe(0);
  });
});

// ─── assignNearestDriver: validation ───────────────────────────────────────────

describe('AssignmentService.assignNearestDriver — validation', () => {
  it('rejects a malformed delivery id before taking the lock', async () => {
    await expect(service.assignNearestDriver('not-an-id')).rejects.toMatchObject({
      statusCode: StatusCodes.BAD_REQUEST,
    });
    expect(mockedWithLock).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown delivery', async () => {
    const error = await service.assignNearestDriver(String(new Types.ObjectId())).catch((e) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(error.statusCode).toBe(StatusCodes.NOT_FOUND);
  });

  it('does not reassign a delivery that already has a driver', async () => {
    const existing = String(new Types.ObjectId());
    const other = await placeDriver(100);
    const delivery = await createFundedDelivery({ driverId: existing });

    const result = await service.assignNearestDriver(String(delivery._id));

    expect(result).toMatchObject({ assigned: false, radiusMeters: 0 });
    expect(result.reason).toMatch(/already has a driver/);
    expect(await driverState(other)).toMatchObject({ isAvailable: true });
  });

  it('rejects a delivery with no pickup coordinates', async () => {
    const delivery = await createFundedDelivery({ withPickup: false });

    await expect(service.assignNearestDriver(String(delivery._id))).rejects.toMatchObject({
      statusCode: StatusCodes.BAD_REQUEST,
    });
  });
});

// ─── autoAssignPendingDeliveries ───────────────────────────────────────────────

describe('AssignmentService.autoAssignPendingDeliveries', () => {
  it('assigns every funded, driverless delivery it can and counts the attempts', async () => {
    await placeDriver(300);
    await placeDriver(900);
    const a = await createFundedDelivery();
    const b = await createFundedDelivery();
    // Not candidates: wrong status, or already has a driver.
    await createFundedDelivery({ status: DeliveryStatus.PENDING });
    await createFundedDelivery({ driverId: String(new Types.ObjectId()) });

    const outcome = await service.autoAssignPendingDeliveries();

    expect(outcome).toEqual({ attempted: 2, assigned: 2 });
    const assigned = await Delivery.find({ _id: { $in: [a._id, b._id] } }).lean();
    expect(assigned.every((d) => d.status === DeliveryStatus.ASSIGNED)).toBe(true);
    expect(new Set(assigned.map((d) => d.driverId)).size).toBe(2);
  });

  it('skips locked and failing deliveries without stopping the sweep', async () => {
    await placeDriver(300);
    const locked = await createFundedDelivery({ createdAt: new Date('2026-01-01T00:00:00Z') });
    const broken = await createFundedDelivery({
      withPickup: false,
      createdAt: new Date('2026-01-02T00:00:00Z'),
    });
    const healthy = await createFundedDelivery({ createdAt: new Date('2026-01-03T00:00:00Z') });
    lock.contended.add(`assignment:delivery:${String(locked._id)}`);

    const outcome = await service.autoAssignPendingDeliveries();

    expect(outcome).toEqual({ attempted: 3, assigned: 1 });
    expect((await Delivery.findById(healthy._id).lean())?.status).toBe(DeliveryStatus.ASSIGNED);
    expect((await Delivery.findById(locked._id).lean())?.status).toBe(DeliveryStatus.FUNDED);
    expect((await Delivery.findById(broken._id).lean())?.status).toBe(DeliveryStatus.FUNDED);
  });

  it('counts a delivery with no reachable driver as attempted but not assigned', async () => {
    await createFundedDelivery();

    expect(await service.autoAssignPendingDeliveries()).toEqual({ attempted: 1, assigned: 0 });
  });

  it('processes the oldest deliveries first and honours the batch limit', async () => {
    await placeDriver(300);
    await placeDriver(600);
    const oldest = await createFundedDelivery({ createdAt: new Date('2026-01-01T00:00:00Z') });
    const newest = await createFundedDelivery({ createdAt: new Date('2026-01-03T00:00:00Z') });
    const middle = await createFundedDelivery({ createdAt: new Date('2026-01-02T00:00:00Z') });

    const outcome = await service.autoAssignPendingDeliveries(2);

    expect(outcome).toEqual({ attempted: 2, assigned: 2 });
    expect(lock.acquired).toEqual([
      `assignment:delivery:${String(oldest._id)}`,
      `assignment:delivery:${String(middle._id)}`,
    ]);
    expect((await Delivery.findById(newest._id).lean())?.status).toBe(DeliveryStatus.FUNDED);
  });

  it('returns zero counts when nothing is waiting for a driver', async () => {
    expect(await service.autoAssignPendingDeliveries()).toEqual({ attempted: 0, assigned: 0 });
  });
});
