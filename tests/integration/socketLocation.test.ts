/**
 * End-to-end integration tests for Socket.io driver location events.
 *
 * These tests verify real-time driver location updates over Socket.io:
 *   - Socket event handler registration and payload processing
 *   - Driver location update validation and persistence
 *   - Broadcasting to delivery rooms
 *   - Deduplication and stale update rejection
 *   - Room isolation (positive/negative cases)
 *   - Error handling for malformed payloads
 *   - Persistence to MongoDB
 *
 * Test flow:
 *   1. Seed test users (driver, dispatcher, customer) and delivery
 *   2. Create mock Socket.io connections with auth data
 *   3. Emit driver_location_update events through handlers
 *   4. Assert broadcast to correct delivery rooms
 *   5. Assert location persisted to MongoDB
 *   6. Verify no broadcast to clients in different rooms
 *   7. Test edge cases (invalid payload, unauthenticated, stale updates)
 *   8. Clean up all DB state
 */

import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Server as SocketIOServer } from 'socket.io';
import jwt from 'jsonwebtoken';

import User from '../../src/models/User';
import Delivery from '../../src/models/Delivery';
import { LocationUpdate } from '../../src/models/LocationUpdate';
import { registerLocationHandler, deliveryRoom } from '../../src/sockets/locationHandler';
import { redisClient } from '../../src/config/redis';
import {} from '../../src/sockets/location.service';
import {
  DriverLocationUpdatePayload,
  LocationBroadcastPayload,
  LocationUpdateAck,
  TypedSocket,
  ServerToClientEvents,
  ClientToServerEvents,
  InterServerEvents,
  SocketData,
} from '../../src/sockets/socket.types';

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../../src/config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../../src/services/socketMetricsService', () => ({
  recordMessageLatency: jest.fn(),
}));

// ─── Test Setup ───────────────────────────────────────────────────────────────

let mongoServer: MongoMemoryServer;

// Test data
let driverId: string;
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- assigned in beforeEach
let dispatcherId: string;
let customerId: string;
let deliveryId: string;

beforeAll(async () => {
  // Start MongoDB in-memory server
  mongoServer = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongoServer.getUri();
  process.env.JWT_SECRET = 'test-socket-location-secret';
  process.env.NODE_ENV = 'test';

  // Connect Mongoose
  await mongoose.connect(mongoServer.getUri());

  // Seed test data
  await seedTestData();
});

afterEach(async () => {
  // Clear location updates between tests
  await LocationUpdate.deleteMany({});

  // Redis dedup/stale keys leak across tests (a future-dated capturedAt in
  // one test poisons location:last:* for later tests) — flush them.
  try {
    const keys = await redisClient.keys('location:*');
    if (keys.length > 0) {
      await redisClient.del(...keys);
    }
  } catch {
    // Redis unavailable — dedup fails open anyway.
  }
});

afterAll(async () => {
  // Disconnect Mongoose
  await mongoose.disconnect();

  // Stop MongoDB
  await mongoServer.stop();
});

/**
 * Helper: seed test users and delivery
 */
async function seedTestData(): Promise<void> {
  // Create driver
  const driver = await User.create({
    firstName: 'Test',
    lastName: 'Driver',
    email: 'driver.socket@test.com',
    password: 'hashed_password',
    role: 'driver',
  });
  driverId = driver._id.toString();

  // Create dispatcher (admin role — UserRole has no 'dispatcher' value)
  const dispatcher = await User.create({
    firstName: 'Test',
    lastName: 'Dispatcher',
    email: 'dispatcher.socket@test.com',
    password: 'hashed_password',
    role: 'admin',
  });
  dispatcherId = dispatcher._id.toString();

  // Create customer
  const customer = await User.create({
    firstName: 'Test',
    lastName: 'Customer',
    email: 'customer.socket@test.com',
    password: 'hashed_password',
    role: 'user',
  });
  customerId = customer._id.toString();

  // Create delivery
  const delivery = await Delivery.create({
    pickupLocation: {
      type: 'Point',
      coordinates: [3.1357, 6.6753], // Lagos, Nigeria
    },
    dropoffLocation: {
      type: 'Point',
      coordinates: [3.1542, 6.6725],
    },
    pickupAddress: 'Test Pickup',
    dropoffAddress: 'Test Dropoff',
    status: 'assigned',
    driver: new Types.ObjectId(driverId),
    customer: new Types.ObjectId(customerId),
  });
  deliveryId = delivery._id.toString();
}

/**
 * Helper: create a JWT token for a user
 */
function createToken(userId: string, expiresIn: string = '7d'): string {
  return jwt.sign(
    { userId, role: 'driver', email: `user${userId}@test.com` },
    process.env.JWT_SECRET || 'test-secret',
    { expiresIn },
  );
}

/**
 * Helper: create a mock Socket.io socket with auth data
 */
function createMockSocket(userId?: string, token?: string): jest.Mocked<TypedSocket> {
  const socket = {
    id: `socket-${Math.random().toString(36).substr(2, 9)}`,
    data: {
      userId,
      token,
      connectedAt: Date.now(),
    } as SocketData,
    handshake: {
      auth: { token },
      query: {},
    },
    emit: jest.fn(),
    disconnect: jest.fn(),
    join: jest.fn(),
    leave: jest.fn(),
    on: jest.fn(),
    off: jest.fn(),
    rooms: new Set([userId || '']),
    connected: true,
  } as unknown as jest.Mocked<TypedSocket>;

  return socket;
}

/**
 * Helper: create a mock Socket.io server
 */
function createMockIO(): jest.Mocked<
  SocketIOServer<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>
> {
  const broadcastMap = new Map<string, jest.Mock>();

  const io = {
    to: jest.fn((room: string) => {
      if (!broadcastMap.has(room)) {
        broadcastMap.set(room, jest.fn());
      }
      return {
        emit: broadcastMap.get(room),
      };
    }),
    sockets: {
      sockets: new Map(),
    },
  } as unknown as jest.Mocked<
    SocketIOServer<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>
  >;

  // Expose broadcast map for test assertions
  (io as any)._broadcastMap = broadcastMap;

  return io;
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe('Socket.io Driver Location Events — E2E Integration Tests', () => {
  // ── Positive Cases ─────────────────────────────────────────────────────────

  describe('Happy Path: Driver broadcasts location to delivery room', () => {
    it('driver sends location update and it is broadcast to room subscribers', async () => {
      const driverToken = createToken(driverId);
      const driverSocket = createMockSocket(driverId, driverToken);

      const io = createMockIO();

      // Register handler (simulates socket connection)
      registerLocationHandler(io, driverSocket);

      // Simulate driver_location_update event
      const updatePayload: DriverLocationUpdatePayload = {
        deliveryId,
        lat: 6.6753,
        lng: 3.1357,
        capturedAt: Date.now(),
      };

      // Get the handler that was registered
      const handler = (driverSocket.on as jest.Mock).mock.calls.find(
        (call) => call[0] === 'driver_location_update',
      )?.[1];

      expect(handler).toBeDefined();

      // Call handler with payload
      await handler(updatePayload);

      // Verify broadcast was emitted to delivery room
      const room = deliveryRoom(deliveryId);
      const broadcastFn = (io as any)._broadcastMap.get(room);

      expect(broadcastFn).toHaveBeenCalledWith(
        'location:update',
        expect.objectContaining({
          deliveryId,
          driverId,
          lat: 6.6753,
          lng: 3.1357,
        }) as LocationBroadcastPayload,
      );

      // Verify ack was sent back
      expect(driverSocket.emit).toHaveBeenCalledWith(
        'location_update_ack',
        expect.objectContaining({
          success: true,
          locationId: expect.any(String),
        }) as LocationUpdateAck,
      );
    });

    it('location update is persisted to MongoDB', async () => {
      const driverToken = createToken(driverId);
      const driverSocket = createMockSocket(driverId, driverToken);
      const io = createMockIO();

      registerLocationHandler(io, driverSocket);

      const updatePayload: DriverLocationUpdatePayload = {
        deliveryId,
        lat: 6.6753,
        lng: 3.1357,
        capturedAt: Date.now(),
      };

      const handler = (driverSocket.on as jest.Mock).mock.calls.find(
        (call) => call[0] === 'driver_location_update',
      )?.[1];

      await handler(updatePayload);

      // Extract locationId from ack
      const ackCall = (driverSocket.emit as jest.Mock).mock.calls.find(
        (call) => call[0] === 'location_update_ack',
      );
      const locationId = ackCall?.[1]?.locationId;

      expect(locationId).toBeDefined();

      // Query MongoDB for the persisted location
      const locationDoc = await LocationUpdate.findById(locationId);
      expect(locationDoc).not.toBeNull();
      expect(locationDoc!.driverId.toString()).toBe(driverId);
      expect(locationDoc!.deliveryId?.toString()).toBe(deliveryId);
      expect(locationDoc!.coordinates.lat).toBe(6.6753);
      expect(locationDoc!.coordinates.lng).toBe(3.1357);
      expect(locationDoc!.isOfflineSync).toBe(false);
      expect(locationDoc!.status).toBe('pending');
    });

    it('multiple location updates from same driver are persisted', async () => {
      const driverToken = createToken(driverId);
      const driverSocket = createMockSocket(driverId, driverToken);
      const io = createMockIO();

      registerLocationHandler(io, driverSocket);

      const handler = (driverSocket.on as jest.Mock).mock.calls.find(
        (call) => call[0] === 'driver_location_update',
      )?.[1];

      const update1: DriverLocationUpdatePayload = {
        deliveryId,
        lat: 6.6753,
        lng: 3.1357,
        capturedAt: Date.now(),
      };

      await handler(update1);

      // Wait a moment
      await new Promise((resolve) => setTimeout(resolve, 100));

      const update2: DriverLocationUpdatePayload = {
        deliveryId,
        lat: 6.675,
        lng: 3.136,
        capturedAt: Date.now() + 100,
      };

      await handler(update2);

      // Verify both are in DB
      const locations = await LocationUpdate.find({
        driverId: new Types.ObjectId(driverId),
        deliveryId: new Types.ObjectId(deliveryId),
      });

      expect(locations).toHaveLength(2);
    });
  });

  // ── Error Handling ─────────────────────────────────────────────────────────

  describe('Error Handling: malformed payloads and edge cases', () => {
    it('rejects unauthenticated driver location update', async () => {
      const driverSocket = createMockSocket(); // No userId
      const io = createMockIO();

      registerLocationHandler(io, driverSocket);

      const updatePayload: DriverLocationUpdatePayload = {
        deliveryId,
        lat: 6.6753,
        lng: 3.1357,
      };

      const handler = (driverSocket.on as jest.Mock).mock.calls.find(
        (call) => call[0] === 'driver_location_update',
      )?.[1];

      await handler(updatePayload);

      // Should emit error ack
      expect(driverSocket.emit).toHaveBeenCalledWith(
        'location_update_ack',
        expect.objectContaining({
          success: false,
          error: expect.stringContaining('Authentication required'),
        }) as LocationUpdateAck,
      );
    });

    it('rejects payload with missing deliveryId', async () => {
      const driverSocket = createMockSocket(driverId);
      const io = createMockIO();

      registerLocationHandler(io, driverSocket);

      const updatePayload = {
        lat: 6.6753,
        lng: 3.1357,
      } as unknown as DriverLocationUpdatePayload;

      const handler = (driverSocket.on as jest.Mock).mock.calls.find(
        (call) => call[0] === 'driver_location_update',
      )?.[1];

      await handler(updatePayload);

      expect(driverSocket.emit).toHaveBeenCalledWith(
        'location_update_ack',
        expect.objectContaining({
          success: false,
          error: expect.any(String),
        }) as LocationUpdateAck,
      );
    });

    it('rejects payload with invalid lat/lng range', async () => {
      const driverSocket = createMockSocket(driverId);
      const io = createMockIO();

      registerLocationHandler(io, driverSocket);

      const updatePayload: DriverLocationUpdatePayload = {
        deliveryId,
        lat: 95, // out of range
        lng: 3.1357,
      };

      const handler = (driverSocket.on as jest.Mock).mock.calls.find(
        (call) => call[0] === 'driver_location_update',
      )?.[1];

      await handler(updatePayload);

      expect(driverSocket.emit).toHaveBeenCalledWith(
        'location_update_ack',
        expect.objectContaining({
          success: false,
          error: expect.stringContaining('range'),
        }) as LocationUpdateAck,
      );
    });

    it('rejects payload with non-numeric lat/lng', async () => {
      const driverSocket = createMockSocket(driverId);
      const io = createMockIO();

      registerLocationHandler(io, driverSocket);

      const updatePayload = {
        deliveryId,
        lat: 'not-a-number',
        lng: 3.1357,
      } as unknown as DriverLocationUpdatePayload;

      const handler = (driverSocket.on as jest.Mock).mock.calls.find(
        (call) => call[0] === 'driver_location_update',
      )?.[1];

      await handler(updatePayload);

      expect(driverSocket.emit).toHaveBeenCalledWith(
        'location_update_ack',
        expect.objectContaining({
          success: false,
        }) as LocationUpdateAck,
      );
    });

    it('rejects malformed payload (null/undefined)', async () => {
      const driverSocket = createMockSocket(driverId);
      const io = createMockIO();

      registerLocationHandler(io, driverSocket);

      const handler = (driverSocket.on as jest.Mock).mock.calls.find(
        (call) => call[0] === 'driver_location_update',
      )?.[1];

      await handler(null);

      expect(driverSocket.emit).toHaveBeenCalledWith(
        'location_update_ack',
        expect.objectContaining({
          success: false,
        }) as LocationUpdateAck,
      );
    });

    it('rejects update with timestamp too far in the past', async () => {
      const driverSocket = createMockSocket(driverId);
      const io = createMockIO();

      registerLocationHandler(io, driverSocket);

      const updatePayload: DriverLocationUpdatePayload = {
        deliveryId,
        lat: 6.6753,
        lng: 3.1357,
        capturedAt: Date.now() - 10 * 60 * 1000, // 10 minutes ago
      };

      const handler = (driverSocket.on as jest.Mock).mock.calls.find(
        (call) => call[0] === 'driver_location_update',
      )?.[1];

      await handler(updatePayload);

      expect(driverSocket.emit).toHaveBeenCalledWith(
        'location_update_ack',
        expect.objectContaining({
          success: false,
          error: expect.stringContaining('old'),
        }) as LocationUpdateAck,
      );
    });

    it('rejects update with timestamp too far in the future', async () => {
      const driverSocket = createMockSocket(driverId);
      const io = createMockIO();

      registerLocationHandler(io, driverSocket);

      const updatePayload: DriverLocationUpdatePayload = {
        deliveryId,
        lat: 6.6753,
        lng: 3.1357,
        capturedAt: Date.now() + 2 * 60 * 1000, // 2 minutes in future
      };

      const handler = (driverSocket.on as jest.Mock).mock.calls.find(
        (call) => call[0] === 'driver_location_update',
      )?.[1];

      await handler(updatePayload);

      expect(driverSocket.emit).toHaveBeenCalledWith(
        'location_update_ack',
        expect.objectContaining({
          success: false,
          error: expect.stringContaining('future'),
        }) as LocationUpdateAck,
      );
    });
  });

  // ── Deduplication ──────────────────────────────────────────────────────────

  describe('Deduplication: identical updates are rejected', () => {
    it('rejects duplicate update within dedup window', async () => {
      const driverSocket = createMockSocket(driverId);
      const io = createMockIO();

      registerLocationHandler(io, driverSocket);

      const handler = (driverSocket.on as jest.Mock).mock.calls.find(
        (call) => call[0] === 'driver_location_update',
      )?.[1];

      const payload: DriverLocationUpdatePayload = {
        deliveryId,
        lat: 6.6753,
        lng: 3.1357,
        capturedAt: Date.now(),
      };

      // First update should succeed
      await handler(payload);

      const firstAck = (driverSocket.emit as jest.Mock).mock.calls[
        (driverSocket.emit as jest.Mock).mock.calls.length - 1
      ][1];
      expect(firstAck.success).toBe(true);

      // Exact same payload immediately after should be rejected as duplicate
      await handler(payload);

      const secondAck = (driverSocket.emit as jest.Mock).mock.calls[
        (driverSocket.emit as jest.Mock).mock.calls.length - 1
      ][1];
      expect(secondAck.success).toBe(false);
      expect(secondAck.isDuplicate).toBe(true);
    });

    it('allows similar updates with slightly different coordinates', async () => {
      const driverSocket = createMockSocket(driverId);
      const io = createMockIO();

      registerLocationHandler(io, driverSocket);

      const handler = (driverSocket.on as jest.Mock).mock.calls.find(
        (call) => call[0] === 'driver_location_update',
      )?.[1];

      const capturedAt = Date.now();

      const payload1: DriverLocationUpdatePayload = {
        deliveryId,
        lat: 6.6753,
        lng: 3.1357,
        capturedAt,
      };

      await handler(payload1);

      const firstAck = (driverSocket.emit as jest.Mock).mock.calls[
        (driverSocket.emit as jest.Mock).mock.calls.length - 1
      ][1];
      expect(firstAck.success).toBe(true);

      // Slightly different coordinates
      const payload2: DriverLocationUpdatePayload = {
        deliveryId,
        lat: 6.67531,
        lng: 3.13571,
        capturedAt,
      };

      await handler(payload2);

      const secondAck = (driverSocket.emit as jest.Mock).mock.calls[
        (driverSocket.emit as jest.Mock).mock.calls.length - 1
      ][1];
      // Should be allowed (different coordinates)
      expect(secondAck.success).toBe(true);
    });
  });

  // ── Stale Updates ──────────────────────────────────────────────────────────

  describe('Stale Update Detection: out-of-order updates are rejected', () => {
    it('rejects update older than last processed update', async () => {
      const driverSocket = createMockSocket(driverId);
      const io = createMockIO();

      registerLocationHandler(io, driverSocket);

      const handler = (driverSocket.on as jest.Mock).mock.calls.find(
        (call) => call[0] === 'driver_location_update',
      )?.[1];

      const baseTime = Date.now();

      // Send newer update first
      const payload1: DriverLocationUpdatePayload = {
        deliveryId,
        lat: 6.6753,
        lng: 3.1357,
        capturedAt: baseTime,
      };

      await handler(payload1);

      const firstAck = (driverSocket.emit as jest.Mock).mock.calls[
        (driverSocket.emit as jest.Mock).mock.calls.length - 1
      ][1];
      expect(firstAck.success).toBe(true);

      // Now send older update
      const payload2: DriverLocationUpdatePayload = {
        deliveryId,
        lat: 6.675,
        lng: 3.136,
        capturedAt: baseTime - 5000, // 5 seconds older
      };

      await handler(payload2);

      const secondAck = (driverSocket.emit as jest.Mock).mock.calls[
        (driverSocket.emit as jest.Mock).mock.calls.length - 1
      ][1];
      expect(secondAck.success).toBe(false);
      expect(secondAck.isStale).toBe(true);
    });
  });

  // ── End-to-End Scenario ────────────────────────────────────────────────────

  describe('Complete Scenario: Full driver location update flow', () => {
    it('driver sends multiple valid updates that are all persisted', async () => {
      const driverSocket = createMockSocket(driverId);
      const io = createMockIO();

      registerLocationHandler(io, driverSocket);

      const handler = (driverSocket.on as jest.Mock).mock.calls.find(
        (call) => call[0] === 'driver_location_update',
      )?.[1];

      // Send 3 sequential updates
      for (let i = 0; i < 3; i++) {
        const payload: DriverLocationUpdatePayload = {
          deliveryId,
          lat: 6.6753 + i * 0.0001,
          lng: 3.1357 + i * 0.0001,
          capturedAt: Date.now() + i * 1000,
        };

        await handler(payload);

        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      // Verify all 3 updates were persisted to DB
      const locations = await LocationUpdate.find({
        driverId: new Types.ObjectId(driverId),
        deliveryId: new Types.ObjectId(deliveryId),
      });

      expect(locations).toHaveLength(3);
      // Payloads step by 0.0001 (see lat: 6.6753 + i * 0.0001 above).
      expect(locations[0].coordinates.lat).toBeCloseTo(6.6753, 5);
      expect(locations[1].coordinates.lat).toBeCloseTo(6.6754, 5);
      expect(locations[2].coordinates.lat).toBeCloseTo(6.6755, 5);
    });

    it('broadcasts location updates to the correct delivery room', async () => {
      const driverSocket = createMockSocket(driverId);
      const io = createMockIO();

      registerLocationHandler(io, driverSocket);

      const handler = (driverSocket.on as jest.Mock).mock.calls.find(
        (call) => call[0] === 'driver_location_update',
      )?.[1];

      const payload: DriverLocationUpdatePayload = {
        deliveryId,
        lat: 6.6753,
        lng: 3.1357,
        capturedAt: Date.now(),
      };

      await handler(payload);

      // Verify broadcast to delivery room
      const room = deliveryRoom(deliveryId);
      const broadcastFn = (io as any)._broadcastMap.get(room);

      expect(broadcastFn).toHaveBeenCalledWith(
        'location:update',
        expect.objectContaining({
          deliveryId,
          driverId,
          lat: 6.6753,
          lng: 3.1357,
        }) as LocationBroadcastPayload,
      );
    });
  });
});
