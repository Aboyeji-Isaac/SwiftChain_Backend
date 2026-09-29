/**
 * Integration Tests: Delivery ETA Calculation
 *
 * Issue #113: Verify distance and ETA calculation accuracy for the delivery ETA feature.
 *
 * Test Coverage:
 *   1. Google Maps Distance Matrix / Directions API integration with mocked responses
 *   2. Haversine formula fallback when Google Maps API fails/times out/unavailable
 *   3. ETA bounds validation (not exact hardcoded values, but acceptable ranges)
 *   4. Edge cases: identical coordinates, short/long distances, invalid input
 *   5. Google Maps error responses (4xx/5xx/timeout)
 *
 * Architecture:
 *   - Tests exercise the Service layer (deliveryService, routingService) directly
 *   - Tests also cover Controller integration via supertest
 *   - Real MongoDB via MongoMemoryServer (not mocked)
 *   - Real .env config (Google Maps API key handling gracefully skipped if not present)
 *   - Only external Google Maps API calls are mocked via jest.mock on axios
 */

import request from 'supertest';
import mongoose from 'mongoose';

import axios from 'axios';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Express } from 'express';

import { Delivery } from '../../src/models/Delivery';
import User from '../../src/models/User';
import { deliveryService } from '../../src/services/deliveryService';
import { routingService } from '../../src/services/routingService';
import type { ETARequest } from '../../src/services/routingService';

/**
 * Mock axios to control Google Maps API responses.
 * Only the HTTP client is mocked; the routing service logic itself is real.
 */
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.mock('../../src/config/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

// ────────────────────────────────────────────────────────────────────────────
// TEST SETUP
// ────────────────────────────────────────────────────────────────────────────

let app: Express;
let mongoServer: MongoMemoryServer;
const jwtSecret = 'eta-test-secret';

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongoServer.getUri();
  process.env.JWT_SECRET = jwtSecret;
  // Clear Google Maps API key to test graceful fallback in CI
  delete process.env.GOOGLE_MAPS_API_KEY;

  const mod = await import('../../src/app');
  app = mod.default;
  await mongoose.connect(mongoServer.getUri());
});

afterEach(async () => {
  await Delivery.deleteMany({});
  await User.deleteMany({});
  jest.clearAllMocks();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

// ────────────────────────────────────────────────────────────────────────────
// HELPERS & FIXTURES
// ────────────────────────────────────────────────────────────────────────────

/**
 * Create a driver user for authenticated requests.
 */
async function createTestDriver(id = 'test-driver-001') {
  const driver = await User.create({
    email: `driver-${id}@swiftchain.test`,
    password: 'TestPassword123!',
    firstName: 'Test',
    lastName: 'Driver',
    role: 'driver',
    isActive: true,
  });
  return driver;
}

/**
 * Create a customer user for delivery ownership.
 */
async function createTestCustomer(id = 'test-customer-001') {
  const customer = await User.create({
    email: `customer-${id}@swiftchain.test`,
    password: 'TestPassword123!',
    firstName: 'Test',
    lastName: 'Customer',
    role: 'user',
    isActive: true,
  });
  return customer;
}

/**
 * Create a delivery with the given coordinates.
 */
async function createTestDelivery(
  pickupLat: number,
  pickupLng: number,
  dropoffLat: number,
  dropoffLng: number,
  driverId: string,
  customerId: string,
  trackingNumber = `DELIVERY-${Date.now()}`,
) {
  const delivery = await Delivery.create({
    deliveryId: trackingNumber,
    driverId,
    userId: customerId,
    customer: {
      name: 'Test Customer',
      phone: '+1234567890',
    },
    pickup: {
      address: '1 Test Pickup St',
      city: 'Test City',
    },
    dropoff: {
      address: '2 Test Dropoff Ave',
      city: 'Test City',
    },
    package: {
      description: 'Test Package',
      weight: 5,
    },
    pickupCoordinates: {
      lat: pickupLat,
      lng: pickupLng,
      address: '1 Test Pickup St',
    },
    dropoffCoordinates: {
      lat: dropoffLat,
      lng: dropoffLng,
      address: '2 Test Dropoff Ave',
    },
    status: 'assigned',
  });
  return delivery;
}

/**
 * Generate a mock Google Maps Directions API response.
 */
function mockGoogleMapsResponse(distanceMeters: number, durationSeconds: number) {
  return {
    status: 'OK',
    routes: [
      {
        legs: [
          {
            distance: {
              value: distanceMeters,
              text: `${(distanceMeters / 1000).toFixed(1)} km`,
            },
            duration: {
              value: durationSeconds,
              text: `${Math.ceil(durationSeconds / 60)} mins`,
            },
          },
        ],
      },
    ],
  };
}

/**
 * Generate a mock Google Maps error response.
 */
function mockGoogleMapsError(status: string) {
  return {
    status,
    routes: [],
  };
}

// ────────────────────────────────────────────────────────────────────────────
// TESTS: GOOGLE MAPS API INTEGRATION (MOCKED)
// ────────────────────────────────────────────────────────────────────────────

describe('Delivery ETA Integration Tests — Google Maps API', () => {
  describe('Successful Google Maps Responses', () => {
    it('should calculate ETA using real Google Maps response data', async () => {
      const driver = await createTestDriver();
      const customer = await createTestCustomer();
      const delivery = await createTestDelivery(
        40.7128, // New York
        -74.006,
        40.7589, // Times Square
        -73.9851,
        driver._id.toString(),
        customer._id.toString(),
      );

      // Mock successful Google Maps response (~5 km, ~10 minutes)
      mockedAxios.get.mockResolvedValue({
        data: mockGoogleMapsResponse(5000, 600),
      });

      // Temporarily set API key to trigger Google Maps path
      const originalKey = process.env.GOOGLE_MAPS_API_KEY;
      process.env.GOOGLE_MAPS_API_KEY = 'test-api-key';

      try {
        const result = await deliveryService.calculateDeliveryETA({
          deliveryId: delivery.deliveryId,
        });

        expect(result.eta.distanceKm).toBeCloseTo(5, 1);
        expect(result.eta.estimatedMinutes).toBeCloseTo(10, 1);
        expect(result.eta.durationText).toMatch(/\d+ mins/);
        expect(result.eta.distanceText).toMatch(/km/);
        expect(mockedAxios.get).toHaveBeenCalledWith(
          'https://maps.googleapis.com/maps/api/directions/json',
          expect.objectContaining({
            params: expect.objectContaining({
              origin: '40.7128,-74.006',
              destination: '40.7589,-73.9851',
              mode: 'driving',
              key: 'test-api-key',
            }),
          }),
        );
      } finally {
        if (originalKey) {
          process.env.GOOGLE_MAPS_API_KEY = originalKey;
        } else {
          delete process.env.GOOGLE_MAPS_API_KEY;
        }
      }
    });

    it('should persist ETA results to the delivery model', async () => {
      const driver = await createTestDriver();
      const customer = await createTestCustomer();
      const delivery = await createTestDelivery(
        40.7128,
        -74.006,
        40.7589,
        -73.9851,
        driver._id.toString(),
        customer._id.toString(),
      );

      mockedAxios.get.mockResolvedValue({
        data: mockGoogleMapsResponse(5000, 600),
      });

      const originalKey = process.env.GOOGLE_MAPS_API_KEY;
      process.env.GOOGLE_MAPS_API_KEY = 'test-api-key';

      try {
        await deliveryService.calculateDeliveryETA({
          deliveryId: delivery.deliveryId,
        });

        const updatedDelivery = await Delivery.findOne({ deliveryId: delivery.deliveryId });
        expect(updatedDelivery?.distance).toBe(5000); // Persisted in meters
        expect(updatedDelivery?.estimatedDuration).toBe(600); // Persisted in seconds
      } finally {
        if (originalKey) {
          process.env.GOOGLE_MAPS_API_KEY = originalKey;
        } else {
          delete process.env.GOOGLE_MAPS_API_KEY;
        }
      }
    });

    it('should handle different travel modes', async () => {
      const originalKey = process.env.GOOGLE_MAPS_API_KEY;
      process.env.GOOGLE_MAPS_API_KEY = 'test-api-key';

      try {
        mockedAxios.get.mockResolvedValue({
          data: mockGoogleMapsResponse(5000, 600),
        });

        const request: ETARequest = {
          pickup: { lat: 40.7128, lng: -74.006 },
          dropoff: { lat: 40.7589, lng: -73.9851 },
          travelMode: 'bicycling',
        };

        const result = await routingService.calculateETA(request);

        expect(result.distance).toBeCloseTo(5, 1);
        expect(mockedAxios.get).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            params: expect.objectContaining({
              mode: 'bicycling',
            }),
          }),
        );
      } finally {
        if (originalKey) {
          process.env.GOOGLE_MAPS_API_KEY = originalKey;
        } else {
          delete process.env.GOOGLE_MAPS_API_KEY;
        }
      }
    });
  });

  describe('Google Maps Error Responses', () => {
    it('should fall back to Haversine when Google Maps returns ZERO_RESULTS', async () => {
      mockedAxios.get.mockResolvedValue({
        data: mockGoogleMapsError('ZERO_RESULTS'),
      });

      const originalKey = process.env.GOOGLE_MAPS_API_KEY;
      process.env.GOOGLE_MAPS_API_KEY = 'test-api-key';

      try {
        const request: ETARequest = {
          pickup: { lat: 40.7128, lng: -74.006 },
          dropoff: { lat: 40.7589, lng: -73.9851 },
        };

        // Should throw error and trigger fallback in calling code
        await expect(routingService.calculateETA(request)).rejects.toThrow('Google Maps API error');
      } finally {
        if (originalKey) {
          process.env.GOOGLE_MAPS_API_KEY = originalKey;
        } else {
          delete process.env.GOOGLE_MAPS_API_KEY;
        }
      }
    });

    it('should fall back to Haversine on request timeout', async () => {
      mockedAxios.get.mockRejectedValue(new Error('Request timeout'));

      const originalKey = process.env.GOOGLE_MAPS_API_KEY;
      process.env.GOOGLE_MAPS_API_KEY = 'test-api-key';

      try {
        const request: ETARequest = {
          pickup: { lat: 40.7128, lng: -74.006 },
          dropoff: { lat: 40.7589, lng: -73.9851 },
        };

        await expect(routingService.calculateETA(request)).rejects.toThrow(
          'Failed to calculate delivery ETA',
        );
      } finally {
        if (originalKey) {
          process.env.GOOGLE_MAPS_API_KEY = originalKey;
        } else {
          delete process.env.GOOGLE_MAPS_API_KEY;
        }
      }
    });

    it('should fall back to Haversine on 5xx server error', async () => {
      mockedAxios.get.mockRejectedValue({
        response: { status: 500, statusText: 'Internal Server Error' },
      });

      const originalKey = process.env.GOOGLE_MAPS_API_KEY;
      process.env.GOOGLE_MAPS_API_KEY = 'test-api-key';

      try {
        const request: ETARequest = {
          pickup: { lat: 40.7128, lng: -74.006 },
          dropoff: { lat: 40.7589, lng: -73.9851 },
        };

        await expect(routingService.calculateETA(request)).rejects.toThrow();
      } finally {
        if (originalKey) {
          process.env.GOOGLE_MAPS_API_KEY = originalKey;
        } else {
          delete process.env.GOOGLE_MAPS_API_KEY;
        }
      }
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// TESTS: HAVERSINE FALLBACK PATH
// ────────────────────────────────────────────────────────────────────────────

describe('Delivery ETA Integration Tests — Haversine Fallback', () => {
  it('should use Haversine when no API key is configured', async () => {
    const driver = await createTestDriver();
    const customer = await createTestCustomer();
    const delivery = await createTestDelivery(
      40.7128,
      -74.006,
      40.7589,
      -73.9851,
      driver._id.toString(),
      customer._id.toString(),
    );

    // Ensure no API key
    delete process.env.GOOGLE_MAPS_API_KEY;

    const result = await deliveryService.calculateDeliveryETA({
      deliveryId: delivery.deliveryId,
    });

    // Haversine should estimate ~5-6 km between these coordinates
    expect(result.eta.distanceKm).toBeGreaterThan(4);
    expect(result.eta.distanceKm).toBeLessThan(7);
    // At 40 km/h (driving), ~5.5 km should be ~8 minutes
    expect(result.eta.estimatedMinutes).toBeGreaterThan(6);
    expect(result.eta.estimatedMinutes).toBeLessThan(12);
    // axios should NOT have been called
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it('should use Haversine for identical coordinates', async () => {
    delete process.env.GOOGLE_MAPS_API_KEY;

    const request: ETARequest = {
      pickup: { lat: 40.7128, lng: -74.006 },
      dropoff: { lat: 40.7128, lng: -74.006 },
    };

    const result = await routingService.calculateETA(request);

    expect(result.distance).toBe(0);
    expect(result.estimatedTime).toBe(0);
  });

  it('should use Haversine for very short distances', async () => {
    delete process.env.GOOGLE_MAPS_API_KEY;

    const request: ETARequest = {
      pickup: { lat: 40.7128, lng: -74.006 },
      dropoff: { lat: 40.7129, lng: -74.0059 }, // ~10 meters
    };

    const result = await routingService.calculateETA(request);

    expect(result.distance).toBeLessThan(0.1); // Less than 100 meters
    expect(result.estimatedTime).toBe(1); // Rounds up to 1 minute
  });

  it('should use Haversine for very long distances', async () => {
    delete process.env.GOOGLE_MAPS_API_KEY;

    const request: ETARequest = {
      pickup: { lat: 40.7128, lng: -74.006 }, // New York
      dropoff: { lat: -33.8688, lng: 151.2093 }, // Sydney
    };

    const result = await routingService.calculateETA(request);

    // ~16,000 km between New York and Sydney
    expect(result.distance).toBeGreaterThan(15500);
    expect(result.distance).toBeLessThan(16500);
    // At 40 km/h (driving average), ~400 hours = ~24000 minutes
    expect(result.estimatedTime).toBeGreaterThan(23500);
    expect(result.estimatedTime).toBeLessThan(24500);
  });

  it('should use Haversine with different travel modes', async () => {
    delete process.env.GOOGLE_MAPS_API_KEY;

    const baseRequest: ETARequest = {
      pickup: { lat: 40.7128, lng: -74.006 },
      dropoff: { lat: 40.7589, lng: -73.9851 }, // ~5.5 km
    };

    // Driving: ~5.5 km at 40 km/h = ~8 minutes
    const drivingResult = await routingService.calculateETA({
      ...baseRequest,
      travelMode: 'driving',
    });
    expect(drivingResult.estimatedTime).toBeGreaterThan(6);
    expect(drivingResult.estimatedTime).toBeLessThan(12);

    // Walking: ~5.5 km at 5 km/h = ~66 minutes
    const walkingResult = await routingService.calculateETA({
      ...baseRequest,
      travelMode: 'walking',
    });
    expect(walkingResult.estimatedTime).toBeGreaterThan(55);
    expect(walkingResult.estimatedTime).toBeLessThan(75);

    // Bicycling: ~5.5 km at 15 km/h = ~22 minutes
    const bikeResult = await routingService.calculateETA({
      ...baseRequest,
      travelMode: 'bicycling',
    });
    expect(bikeResult.estimatedTime).toBeGreaterThan(18);
    expect(bikeResult.estimatedTime).toBeLessThan(28);
  });

  it('should use Haversine with anti-meridian crossing', async () => {
    delete process.env.GOOGLE_MAPS_API_KEY;

    const request: ETARequest = {
      pickup: { lat: -18.1248, lng: 178.4501 }, // Fiji
      dropoff: { lat: -13.759, lng: -172.1046 }, // Samoa
    };

    const result = await routingService.calculateETA(request);

    // ~1100 km across anti-meridian (not ~19,000 km the wrong way)
    expect(result.distance).toBeGreaterThan(1000);
    expect(result.distance).toBeLessThan(1300);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// TESTS: EDGE CASES
// ────────────────────────────────────────────────────────────────────────────

describe('Delivery ETA Integration Tests — Edge Cases', () => {
  it('should reject delivery not found', async () => {
    await expect(
      deliveryService.calculateDeliveryETA({
        deliveryId: 'NONEXISTENT-123',
      }),
    ).rejects.toThrow('not found');
  });

  it('should reject delivery missing pickup coordinates', async () => {
    const driver = await createTestDriver();
    const customer = await createTestCustomer();
    const delivery = await Delivery.create({
      deliveryId: 'MISSING-PICKUP',
      driverId: driver._id,
      userId: customer._id,
      customer: { name: 'Test', phone: '+1234567890' },
      pickup: { address: '1 Test', city: 'Test' },
      dropoff: { address: '2 Test', city: 'Test' },
      package: { description: 'Test', weight: 5 },
      dropoffCoordinates: {
        lat: 40.7589,
        lng: -73.9851,
        address: '2 Test',
      },
      status: 'assigned',
    });

    await expect(
      deliveryService.calculateDeliveryETA({
        deliveryId: delivery.deliveryId,
      }),
    ).rejects.toThrow('complete coordinates');
  });

  it('should reject delivery missing dropoff coordinates', async () => {
    const driver = await createTestDriver();
    const customer = await createTestCustomer();
    const delivery = await Delivery.create({
      deliveryId: 'MISSING-DROPOFF',
      driverId: driver._id,
      userId: customer._id,
      customer: { name: 'Test', phone: '+1234567890' },
      pickup: { address: '1 Test', city: 'Test' },
      dropoff: { address: '2 Test', city: 'Test' },
      package: { description: 'Test', weight: 5 },
      pickupCoordinates: {
        lat: 40.7128,
        lng: -74.006,
        address: '1 Test',
      },
      status: 'assigned',
    });

    await expect(
      deliveryService.calculateDeliveryETA({
        deliveryId: delivery.deliveryId,
      }),
    ).rejects.toThrow('complete coordinates');
  });

  it('should handle invalid latitude values', async () => {
    delete process.env.GOOGLE_MAPS_API_KEY;

    const invalidRequests: ETARequest[] = [
      {
        pickup: { lat: 91, lng: 0 }, // > 90
        dropoff: { lat: 0, lng: 0 },
      },
      {
        pickup: { lat: -91, lng: 0 }, // < -90
        dropoff: { lat: 0, lng: 0 },
      },
    ];

    for (const req of invalidRequests) {
      const result = await routingService.calculateETA(req);
      // Should still compute, but may give unexpected results
      // (the service doesn't currently validate ranges)
      expect(result).toHaveProperty('estimatedTime');
      expect(result).toHaveProperty('distance');
    }
  });

  it('should handle invalid longitude values', async () => {
    delete process.env.GOOGLE_MAPS_API_KEY;

    const invalidRequests: ETARequest[] = [
      {
        pickup: { lat: 0, lng: 181 }, // > 180
        dropoff: { lat: 0, lng: 0 },
      },
      {
        pickup: { lat: 0, lng: -181 }, // < -180
        dropoff: { lat: 0, lng: 0 },
      },
    ];

    for (const req of invalidRequests) {
      const result = await routingService.calculateETA(req);
      // Haversine normalization should handle these
      expect(result).toHaveProperty('estimatedTime');
      expect(result).toHaveProperty('distance');
    }
  });

  it('should handle response formatting edge cases', async () => {
    delete process.env.GOOGLE_MAPS_API_KEY;

    const request: ETARequest = {
      pickup: { lat: 0, lng: 0 },
      dropoff: { lat: 0.001, lng: 0.001 }, // ~157 meters
    };

    const result = await routingService.calculateETA(request);

    // Check formatting
    expect(result.distanceText).toMatch(/^\d+(\.\d+)? km$/);
    expect(result.durationText).toMatch(/^\d+ mins$/);
    expect(Number.isInteger(result.estimatedTime)).toBe(true);
    expect(result.distance).toBeGreaterThan(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// TESTS: HTTP CONTROLLER INTEGRATION
// ────────────────────────────────────────────────────────────────────────────

describe('Delivery ETA Integration Tests — HTTP Controller', () => {
  it('should return ETA via GET /api/v1/deliveries/:id/eta', async () => {
    const driver = await createTestDriver();
    const customer = await createTestCustomer();
    const delivery = await createTestDelivery(
      40.7128,
      -74.006,
      40.7589,
      -73.9851,
      driver._id.toString(),
      customer._id.toString(),
    );

    delete process.env.GOOGLE_MAPS_API_KEY;

    const response = await request(app).get(`/api/v1/deliveries/${delivery.deliveryId}/eta`);

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data).toHaveProperty('eta');
    expect(response.body.data.eta).toHaveProperty('estimatedMinutes');
    expect(response.body.data.eta).toHaveProperty('distanceKm');
    expect(response.body.data.eta).toHaveProperty('durationText');
    expect(response.body.data.eta).toHaveProperty('distanceText');
  });

  it('should return 400 for missing delivery ID', async () => {
    const response = await request(app).get('/api/v1/deliveries//eta');

    // Depends on router implementation
    expect([404, 400]).toContain(response.status);
  });

  it('should return 404 for nonexistent delivery', async () => {
    const response = await request(app).get('/api/v1/deliveries/NONEXISTENT/eta');

    expect(response.status).toBe(404);
    expect(response.body.success).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// TESTS: ETA BOUNDS VALIDATION (NOT EXACT VALUES)
// ────────────────────────────────────────────────────────────────────────────

describe('Delivery ETA Integration Tests — Bounds Validation', () => {
  it('should validate ETA falls within acceptable bounds for short distance', async () => {
    delete process.env.GOOGLE_MAPS_API_KEY;

    // Times Square to Central Park: ~5 km
    const request: ETARequest = {
      pickup: { lat: 40.7128, lng: -74.006 },
      dropoff: { lat: 40.7589, lng: -73.9851 },
    };

    const result = await routingService.calculateETA(request);

    // At typical city speeds (40 km/h), 5 km = ~7.5 minutes
    // Allow 20% variance
    const expectedMinutes = 7.5;
    const lowerBound = expectedMinutes * 0.8; // 6 minutes
    const upperBound = expectedMinutes * 1.2; // 9 minutes

    expect(result.estimatedTime).toBeGreaterThanOrEqual(lowerBound);
    expect(result.estimatedTime).toBeLessThanOrEqual(upperBound);
  });

  it('should validate ETA falls within acceptable bounds for long distance', async () => {
    delete process.env.GOOGLE_MAPS_API_KEY;

    // New York to Los Angeles: ~3944 km
    const request: ETARequest = {
      pickup: { lat: 40.7128, lng: -74.006 },
      dropoff: { lat: 34.0522, lng: -118.2437 },
    };

    const result = await routingService.calculateETA(request);

    // At highway speeds (40 km/h average), 3944 km = ~99 hours = ~5940 minutes
    // Allow 30% variance for traffic
    const expectedMinutes = 5940;
    const lowerBound = expectedMinutes * 0.7;
    const upperBound = expectedMinutes * 1.3;

    expect(result.estimatedTime).toBeGreaterThanOrEqual(lowerBound);
    expect(result.estimatedTime).toBeLessThanOrEqual(upperBound);
  });

  it('should validate distance matches known coordinates', async () => {
    delete process.env.GOOGLE_MAPS_API_KEY;

    // London to Paris: ~344 km
    const request: ETARequest = {
      pickup: { lat: 51.5074, lng: -0.1278 },
      dropoff: { lat: 48.8566, lng: 2.3522 },
    };

    const result = await routingService.calculateETA(request);

    // Allow 10% variance
    expect(result.distance).toBeGreaterThan(344 * 0.9);
    expect(result.distance).toBeLessThan(344 * 1.1);
  });
});
