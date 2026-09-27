/**
 * Tests for the DriverLocation model and the proximity search service.
 *
 * Runs against mongodb-memory-server so the 2dsphere indexes, the GeoJSON
 * validation and the `$geoNear` pipeline are exercised for real rather than
 * mocked. All assertions read data back out of the database.
 */

import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { DriverLocation } from '../src/models/DriverLocation';
import { DriverLocationService } from '../src/services/driverLocationService';
import AppError from '../src/utils/AppError';

jest.mock('../src/config/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    http: jest.fn(),
  },
}));

// Reference points in Lagos, with roughly known separations.
const LAGOS = { lat: 6.5244, lng: 3.3792 };
/** ~1.1 km north of LAGOS. */
const NEARBY = { lat: 6.5344, lng: 3.3792 };
/** ~11 km north of LAGOS. */
const FAR = { lat: 6.6244, lng: 3.3792 };

describe('DriverLocation', () => {
  let mongod: MongoMemoryServer;
  const service = new DriverLocationService();

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    // Indexes must exist before any $geoNear query runs.
    await DriverLocation.createIndexes();
  }, 120_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  }, 30_000);

  afterEach(async () => {
    await DriverLocation.deleteMany({});
  });

  /** Insert a driver at a coordinate with the given availability. */
  const seedDriver = async (
    point: { lat: number; lng: number },
    overrides: Partial<{ isAvailable: boolean; status: string }> = {},
  ): Promise<Types.ObjectId> => {
    const driverId = new Types.ObjectId();

    await DriverLocation.create({
      driverId,
      location: { type: 'Point', coordinates: [point.lng, point.lat] },
      isAvailable: overrides.isAvailable ?? true,
      status: overrides.status ?? 'online',
      recordedAt: new Date(),
    });

    return driverId;
  };

  // ── Schema ────────────────────────────────────────────────────────────────

  describe('schema', () => {
    it('stores coordinates in GeoJSON [lng, lat] order', async () => {
      const driverId = await seedDriver(LAGOS);
      const found = await DriverLocation.findOne({ driverId });

      expect(found?.location.coordinates).toEqual([LAGOS.lng, LAGOS.lat]);
    });

    it('exposes the position in API {lat, lng} order via toLatLng', async () => {
      const driverId = await seedDriver(LAGOS);
      const found = await DriverLocation.findOne({ driverId });

      expect(found?.toLatLng()).toEqual({ lat: LAGOS.lat, lng: LAGOS.lng });
    });

    it('rejects an out-of-range latitude', async () => {
      await expect(
        DriverLocation.create({
          driverId: new Types.ObjectId(),
          location: { type: 'Point', coordinates: [3.37, 91] },
          recordedAt: new Date(),
        }),
      ).rejects.toThrow();
    });

    it('rejects an out-of-range longitude', async () => {
      await expect(
        DriverLocation.create({
          driverId: new Types.ObjectId(),
          location: { type: 'Point', coordinates: [181, 6.5] },
          recordedAt: new Date(),
        }),
      ).rejects.toThrow();
    });

    it('allows only one location document per driver', async () => {
      const driverId = new Types.ObjectId();
      const doc = {
        driverId,
        location: { type: 'Point' as const, coordinates: [3.37, 6.5] as [number, number] },
        recordedAt: new Date(),
      };

      await DriverLocation.create(doc);
      await expect(DriverLocation.create(doc)).rejects.toThrow();
    });

    it('derives expiresAt from recordedAt so stale records are retired', async () => {
      const driverId = await seedDriver(LAGOS);
      const found = await DriverLocation.findOne({ driverId });

      expect(found?.expiresAt.getTime()).toBeGreaterThan(found!.recordedAt.getTime());
    });
  });

  // ── Indexes ───────────────────────────────────────────────────────────────

  describe('indexes', () => {
    it('creates both the plain and the compound 2dsphere indexes', async () => {
      const names = (await DriverLocation.collection.indexes()).map((index) => index.name);

      expect(names).toContain('location_2dsphere');
      expect(names).toContain('availability_location_2dsphere');
      expect(names).toContain('driver_location_ttl');
    });

    it('orders the compound index with equality fields before the geometry', async () => {
      const indexes = await DriverLocation.collection.indexes();
      const compound = indexes.find((i) => i.name === 'availability_location_2dsphere');

      // Key order decides whether the planner can seek before walking geometry.
      expect(Object.keys(compound!.key)).toEqual(['isAvailable', 'status', 'location']);
    });

    it('ensureIndexes reports the indexes present on the collection', async () => {
      const names = await service.ensureIndexes();
      expect(names).toContain('availability_location_2dsphere');
    });
  });

  // ── Proximity search ──────────────────────────────────────────────────────

  describe('findNearbyDrivers', () => {
    it('returns drivers inside the radius and excludes those outside it', async () => {
      const near = await seedDriver(NEARBY);
      await seedDriver(FAR);

      const result = await service.findNearbyDrivers({ ...LAGOS, radiusMeters: 5000 });

      expect(result.count).toBe(1);
      expect(result.drivers[0].driverId).toBe(near.toString());
    });

    it('orders results nearest first', async () => {
      const near = await seedDriver(NEARBY);
      const far = await seedDriver(FAR);

      const result = await service.findNearbyDrivers({ ...LAGOS, radiusMeters: 20000 });

      expect(result.drivers.map((d) => d.driverId)).toEqual([near.toString(), far.toString()]);
      expect(result.drivers[0].distanceMeters).toBeLessThan(result.drivers[1].distanceMeters);
    });

    it('returns a distance computed by the database, not a placeholder', async () => {
      await seedDriver(NEARBY);

      const result = await service.findNearbyDrivers({ ...LAGOS, radiusMeters: 5000 });

      // NEARBY is ~1.1 km away; allow a generous band around that.
      expect(result.drivers[0].distanceMeters).toBeGreaterThan(800);
      expect(result.drivers[0].distanceMeters).toBeLessThan(1500);
    });

    it('excludes unavailable drivers by default', async () => {
      await seedDriver(NEARBY, { isAvailable: false });

      const result = await service.findNearbyDrivers({ ...LAGOS, radiusMeters: 5000 });
      expect(result.count).toBe(0);
    });

    it('includes unavailable drivers when availableOnly is false', async () => {
      await seedDriver(NEARBY, { isAvailable: false });

      const result = await service.findNearbyDrivers({
        ...LAGOS,
        radiusMeters: 5000,
        availableOnly: false,
      });

      expect(result.count).toBe(1);
    });

    it('filters by availability status', async () => {
      await seedDriver(NEARBY, { status: 'on_delivery' });
      const online = await seedDriver(NEARBY, { status: 'online' });

      const result = await service.findNearbyDrivers({
        ...LAGOS,
        radiusMeters: 5000,
        status: 'online',
      });

      expect(result.count).toBe(1);
      expect(result.drivers[0].driverId).toBe(online.toString());
    });

    it('honours the result limit', async () => {
      await seedDriver(NEARBY);
      await seedDriver(NEARBY);
      await seedDriver(NEARBY);

      const result = await service.findNearbyDrivers({ ...LAGOS, radiusMeters: 5000, limit: 2 });
      expect(result.drivers).toHaveLength(2);
    });

    it('echoes back the centre and the radius actually applied', async () => {
      const result = await service.findNearbyDrivers({ ...LAGOS, radiusMeters: 3000 });

      expect(result.center).toEqual(LAGOS);
      expect(result.radiusMeters).toBe(3000);
    });

    it('returns an empty result rather than throwing when nothing matches', async () => {
      const result = await service.findNearbyDrivers({ ...LAGOS, radiusMeters: 1000 });

      expect(result.count).toBe(0);
      expect(result.drivers).toEqual([]);
    });

    it.each([
      ['lat', { lat: 91, lng: 3.37 }],
      ['lat', { lat: -91, lng: 3.37 }],
      ['lng', { lat: 6.5, lng: 181 }],
      ['lng', { lat: 6.5, lng: -181 }],
    ])('rejects an out-of-range %s', async (_field, coords) => {
      await expect(service.findNearbyDrivers(coords)).rejects.toBeInstanceOf(AppError);
    });

    it('rejects a non-positive radius', async () => {
      await expect(service.findNearbyDrivers({ ...LAGOS, radiusMeters: 0 })).rejects.toBeInstanceOf(
        AppError,
      );
    });

    it('rejects a radius beyond the configured maximum', async () => {
      await expect(
        service.findNearbyDrivers({ ...LAGOS, radiusMeters: 10_000_000 }),
      ).rejects.toBeInstanceOf(AppError);
    });
  });

  // ── Writes ────────────────────────────────────────────────────────────────

  describe('upsertDriverLocation', () => {
    it('creates a record on the first report', async () => {
      const driverId = new Types.ObjectId().toString();

      await service.upsertDriverLocation({ driverId, ...LAGOS, isAvailable: true });

      expect(await DriverLocation.countDocuments({ driverId })).toBe(1);
    });

    it('updates in place rather than inserting a second row', async () => {
      const driverId = new Types.ObjectId().toString();

      await service.upsertDriverLocation({ driverId, ...LAGOS });
      await service.upsertDriverLocation({ driverId, ...NEARBY });

      expect(await DriverLocation.countDocuments({ driverId })).toBe(1);

      const stored = await DriverLocation.findOne({ driverId });
      expect(stored?.location.coordinates).toEqual([NEARBY.lng, NEARBY.lat]);
    });

    it('persists the optional telemetry fields', async () => {
      const driverId = new Types.ObjectId().toString();

      await service.upsertDriverLocation({
        driverId,
        ...LAGOS,
        heading: 90,
        speed: 12.5,
        accuracy: 5,
        status: 'on_delivery',
      });

      const stored = await DriverLocation.findOne({ driverId });
      expect(stored?.heading).toBe(90);
      expect(stored?.speed).toBe(12.5);
      expect(stored?.status).toBe('on_delivery');
    });

    it('rejects a malformed driver id', async () => {
      await expect(
        service.upsertDriverLocation({ driverId: 'not-an-id', ...LAGOS }),
      ).rejects.toBeInstanceOf(AppError);
    });

    it('makes a newly reported driver findable by proximity search', async () => {
      const driverId = new Types.ObjectId().toString();

      await service.upsertDriverLocation({
        driverId,
        ...NEARBY,
        isAvailable: true,
        status: 'online',
      });

      const result = await service.findNearbyDrivers({ ...LAGOS, radiusMeters: 5000 });
      expect(result.drivers[0].driverId).toBe(driverId);
    });
  });

  describe('getDriverLocation', () => {
    it('returns the stored position', async () => {
      const driverId = await seedDriver(LAGOS);
      const found = await service.getDriverLocation(driverId.toString());

      expect(found.toLatLng()).toEqual(LAGOS);
    });

    it('throws 404 when the driver has no position on record', async () => {
      await expect(
        service.getDriverLocation(new Types.ObjectId().toString()),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it('throws 400 for a malformed id', async () => {
      await expect(service.getDriverLocation('nope')).rejects.toMatchObject({
        statusCode: 400,
      });
    });
  });

  // ── Profiling ─────────────────────────────────────────────────────────────

  describe('explainProximityQuery', () => {
    it('reports that the query is served by a geospatial index', async () => {
      await seedDriver(NEARBY);

      const plan = await service.explainProximityQuery({ ...LAGOS, radiusMeters: 5000 });

      // The planner must choose one of the 2dsphere indexes, never a COLLSCAN.
      expect(plan.indexUsed).toMatch(/2dsphere/);
    });
  });
});
