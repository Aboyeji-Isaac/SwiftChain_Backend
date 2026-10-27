jest.mock('../src/models/DriverProfile', () => ({
  __esModule: true,
  default: {
    aggregate: jest.fn(),
  },
}));

jest.mock('../src/models/User', () => ({
  __esModule: true,
  default: { collection: { name: 'users' } },
}));

jest.mock('../src/models/DriverLocation', () => ({
  __esModule: true,
  DriverLocation: { collection: { name: 'driverlocations' } },
}));

import DriverProfile from '../src/models/DriverProfile';
import { AdminDriverRepository } from '../src/repositories/AdminDriverRepository';
import { AdminDriverSearchService } from '../src/services/adminDriverSearchService';
import { QueryOptions } from '../src/types/query';

type Stage = Record<string, unknown>;

const aggregateMock = DriverProfile.aggregate as unknown as jest.Mock;

const options = (
  filter: Record<string, unknown> = {},
  page = 1,
  limit = 20,
  sort: Record<string, 1 | -1> = { createdAt: -1 },
): QueryOptions => ({
  page,
  limit,
  skip: (page - 1) * limit,
  sort,
  filter: filter as QueryOptions['filter'],
});

const runSearch = async (
  filter: Record<string, unknown> = {},
  search?: string,
  queryOptions: QueryOptions = options(filter),
): Promise<Stage[]> => {
  aggregateMock.mockReturnValue({
    exec: jest.fn().mockResolvedValue([{ items: [], total: [{ value: 7 }] }]),
  });
  await new AdminDriverRepository().search(queryOptions, search);
  return aggregateMock.mock.calls[aggregateMock.mock.calls.length - 1][0] as Stage[];
};

describe('AdminDriverRepository', () => {
  beforeEach(() => {
    aggregateMock.mockReset();
  });

  it('searches names and email with an escaped, case-insensitive term', async () => {
    const pipeline = await runSearch({}, 'Ada.+');
    const searchStage = pipeline.find((stage) => {
      const match = stage.$match as Record<string, unknown> | undefined;
      return Boolean(match?.$or);
    });
    const match = searchStage?.$match as { $or: Array<Record<string, unknown>> };

    expect(match.$or).toHaveLength(4);
    expect(match.$or[0]['user.firstName']).toEqual(/Ada\.\+/i);
    expect(match.$or[1]['user.lastName']).toBeInstanceOf(RegExp);
    expect(match.$or[2]['user.email']).toBeInstanceOf(RegExp);
    expect(match.$or[3]._searchFullName).toEqual(/Ada\.\+/i);
  });

  it('maps tier and minimum vehicle capacity filters to profile fields', async () => {
    const pipeline = await runSearch({ tier: 'gold', minVehicleCapacity: 750 });
    const match = pipeline[0].$match as Record<string, unknown>;

    expect(match.tier).toBe('gold');
    expect(match['vehicleDetails.capacityKg']).toEqual({ $gte: 750 });
  });

  it('applies reputation and completed-delivery ranges', async () => {
    const pipeline = await runSearch({
      minReputation: 100,
      maxReputation: 900,
      minCompletedDeliveries: 5,
      maxCompletedDeliveries: 50,
      minTotalDeliveries: 10,
      maxTotalDeliveries: 100,
    });
    const match = pipeline[0].$match as Record<string, unknown>;

    expect(match.reputationPoints).toEqual({ $gte: 100, $lte: 900 });
    expect(match.completedDeliveries).toEqual({ $gte: 5, $lte: 50 });
    expect(match.totalDeliveries).toEqual({ $gte: 10, $lte: 100 });
  });

  it.each([
    ['available', { 'driverLocation.isAvailable': true }],
    [
      'unavailable',
      {
        $or: [
          { 'driverLocation.isAvailable': false },
          { driverLocation: { $exists: false } },
          { driverLocation: null },
        ],
      },
    ],
    ['online', { 'driverLocation.status': 'online' }],
    [
      'offline',
      {
        $or: [
          { 'driverLocation.status': 'offline' },
          { driverLocation: { $exists: false } },
          { driverLocation: null },
        ],
      },
    ],
    ['on_delivery', { 'driverLocation.status': 'on_delivery' }],
  ])('filters availability=%s', async (availability, expected) => {
    const pipeline = await runSearch({ availability });
    const matchStages = pipeline
      .filter((stage) => '$match' in stage)
      .map((stage) => stage.$match as Record<string, unknown>);

    expect(matchStages).toContainEqual(expected);
  });

  it('uses query middleware pagination and whitelisted sorting in the aggregation', async () => {
    const pipeline = await runSearch(
      { tier: 'silver' },
      undefined,
      options({ tier: 'silver' }, 3, 10, { reputationPoints: -1 }),
    );
    const facet = pipeline[pipeline.length - 1].$facet as {
      items: Stage[];
      total: Stage[];
    };

    expect(facet.items[0].$sort).toEqual({ reputationPoints: -1 });
    expect(facet.items[1].$skip).toBe(20);
    expect(facet.items[2].$limit).toBe(10);
    expect(facet.total).toEqual([{ $count: 'value' }]);
    expect(facet.items[3].$project).not.toHaveProperty('password');
  });

  it('rejects invalid range bounds and unsupported filter values', async () => {
    await expect(
      new AdminDriverRepository().search(options({ minReputation: 500, maxReputation: 100 })),
    ).rejects.toThrow('minReputation cannot exceed maxReputation');

    await expect(
      new AdminDriverRepository().search(options({ availability: 'unknown' })),
    ).rejects.toThrow('availability must be one of');
  });
});

describe('AdminDriverSearchService', () => {
  it('returns flattened driver DTOs and pagination metadata without password fields', async () => {
    const fakeRepository = {
      search: jest.fn().mockResolvedValue({
        total: 21,
        items: [
          {
            _id: 'profile-1',
            userId: 'user-1',
            firstName: 'Ada',
            lastName: 'Driver',
            email: 'ada@example.test',
            accountStatus: 'active',
            accountActive: true,
            tier: 'gold',
            reputationPoints: 500,
            rating: 4.8,
            totalDeliveries: 30,
            completedDeliveries: 25,
            vehicleDetails: { make: 'Van', model: 'X', capacityKg: 1000 },
            isSuspended: false,
            suspendedUntil: null,
            availabilityStatus: 'online',
            isAvailable: true,
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            updatedAt: new Date('2026-01-02T00:00:00.000Z'),
          },
        ],
      }),
    };
    const service = new AdminDriverSearchService(fakeRepository as unknown as AdminDriverRepository);

    const result = await service.search(options({}, 2, 10));

    expect(result.drivers[0]).toMatchObject({
      id: 'profile-1',
      userId: 'user-1',
      firstName: 'Ada',
      email: 'ada@example.test',
      vehicleCapacityKg: 1000,
      availabilityStatus: 'online',
    });
    expect(result.drivers[0]).not.toHaveProperty('password');
    expect(result.meta).toMatchObject({
      totalItems: 21,
      totalPages: 3,
      currentPage: 2,
      limit: 10,
      hasNextPage: true,
      hasPreviousPage: true,
      nextPage: 3,
      previousPage: 1,
    });
  });
});
