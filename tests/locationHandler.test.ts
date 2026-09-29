/**
 * Unit tests for locationHandler token expiration check
 *
 * Tests cover:
 *   - setupTokenExpirationCheck skips unauthenticated sockets
 *   - Token validation runs on an interval
 *   - auth_expired is emitted when token validation fails
 *   - auth_refresh clears the grace timer and updates the token
 *   - Graceful disconnect after grace period expires
 *   - Intervals are cleaned up on disconnect
 */

import { registerLocationHandler, deliveryRoom } from '../src/sockets/locationHandler';
import {
  TypedSocket,
  ServerToClientEvents,
  ClientToServerEvents,
  InterServerEvents,
  SocketData,
  AuthExpiredPayload,
  AuthRefreshPayload,
  AuthRefreshAckPayload,
} from '../src/sockets/socket.types';
import { Server as SocketIOServer } from 'socket.io';

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../src/config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../src/services/authService', () => ({
  verifyToken: jest.fn(),
  getUserById: jest.fn(),
}));

jest.mock('../src/sockets/socket.service', () => {
  const actual = jest.requireActual('../src/sockets/socket.service');
  return {
    ...actual,
    socketService: {
      validateSocketToken: jest.fn(),
    },
  };
});

import authService from '../src/services/authService';
import { socketService } from '../src/sockets/socket.service';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMockSocket(id: string): jest.Mocked<TypedSocket> {
  return {
    id,
    data: {},
    handshake: { auth: {}, query: {} },
    emit: jest.fn(),
    disconnect: jest.fn(),
    join: jest.fn(),
    leave: jest.fn(),
    on: jest.fn(),
    off: jest.fn(),
    rooms: new Set([id]),
    connected: true,
  } as unknown as jest.Mocked<TypedSocket>;
}

function makeMockIO(): Parameters<typeof registerLocationHandler>[0] {
  return {
    to: jest.fn().mockReturnValue({ emit: jest.fn() }),
    sockets: { sockets: new Map() },
  } as unknown as SocketIOServer<
    ClientToServerEvents,
    ServerToClientEvents,
    InterServerEvents,
    SocketData
  >;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('locationHandler — token expiration', () => {
  let socket: jest.Mocked<TypedSocket>;
  let io: ReturnType<typeof makeMockIO>;

  beforeEach(() => {
    jest.useFakeTimers();
    socket = makeMockSocket('socket-1');
    io = makeMockIO();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('setupTokenExpirationCheck', () => {
    it('does nothing when socket has no token or userId', () => {
      socket.data.token = undefined;
      socket.data.userId = undefined;

      registerLocationHandler(io, socket);

      expect(socket.on).not.toHaveBeenCalledWith('auth_refresh', expect.any(Function));
    });

    it('does nothing when token is present but userId is missing', () => {
      socket.data.token = 'some-token';
      socket.data.userId = undefined;

      registerLocationHandler(io, socket);

      expect(socket.on).not.toHaveBeenCalledWith('auth_refresh', expect.any(Function));
    });

    it('sets up periodic token validation when token and userId are present', async () => {
      socket.data.token = 'valid-token';
      socket.data.userId = 'user-1';

      (socketService.validateSocketToken as jest.Mock).mockResolvedValue(true);

      registerLocationHandler(io, socket);

      expect(socket.on).toHaveBeenCalledWith('auth_refresh', expect.any(Function));

      // Advance past the initial 5s delay
      jest.advanceTimersByTime(5_000);
      await Promise.resolve();
      expect(socketService.validateSocketToken).toHaveBeenCalledWith(socket);

      // Advance one check interval
      jest.advanceTimersByTime(60_000);
      await Promise.resolve();
      expect(socketService.validateSocketToken).toHaveBeenCalledTimes(2);
    });

    it('emits auth_expired and disconnects after grace period on invalid token', async () => {
      socket.data.token = 'expired-token';
      socket.data.userId = 'user-1';

      (socketService.validateSocketToken as jest.Mock).mockResolvedValue(false);

      registerLocationHandler(io, socket);

      // Advance past initial delay + one check interval
      jest.advanceTimersByTime(5_000);
      await Promise.resolve();

      // Validation failed — auth_expired should be emitted
      expect(socket.emit).toHaveBeenCalledWith(
        'auth_expired',
        expect.objectContaining({
          message: 'Your session has expired. Please refresh your token.',
          gracePeriodMs: 30_000,
        }) as AuthExpiredPayload,
      );

      // Advance past grace period
      jest.advanceTimersByTime(30_000);
      await Promise.resolve();
      expect(socket.disconnect).toHaveBeenCalledWith(true);
    });

    it('clears grace timer and updates token on valid auth_refresh', async () => {
      socket.data.token = 'old-token';
      socket.data.userId = 'user-1';

      (socketService.validateSocketToken as jest.Mock).mockResolvedValue(false);

      registerLocationHandler(io, socket);

      // Trigger invalid token
      jest.advanceTimersByTime(5_000);
      await Promise.resolve();
      expect(socket.emit).toHaveBeenCalledWith(
        'auth_expired',
        expect.any(Object) as AuthExpiredPayload,
      );

      // Find the auth_refresh handler registered by registerLocationHandler
      const authRefreshHandler = (socket.on as jest.Mock).mock.calls.find(
        (call: string[]) => call[0] === 'auth_refresh',
      )?.[1] as (payload: AuthRefreshPayload) => Promise<void>;

      expect(authRefreshHandler).toBeDefined();

      // Simulate client sending a refreshed token
      (authService.verifyToken as jest.Mock).mockReturnValue({ userId: 'user-1' });
      (authService.getUserById as jest.Mock).mockResolvedValue({ status: 'active' });

      await authRefreshHandler({ token: 'new-token' });

      expect(socket.data.token).toBe('new-token');
      expect(socket.data.userId).toBe('user-1');
      expect(socket.emit).toHaveBeenCalledWith('auth_refresh_ack', {
        success: true,
      } as AuthRefreshAckPayload);

      // Advance past where disconnect would have happened — should NOT disconnect
      jest.advanceTimersByTime(35_000);
      await Promise.resolve();
      expect(socket.disconnect).not.toHaveBeenCalled();
    });

    it('rejects invalid token on auth_refresh', async () => {
      socket.data.token = 'old-token';
      socket.data.userId = 'user-1';

      registerLocationHandler(io, socket);

      const authRefreshHandler = (socket.on as jest.Mock).mock.calls.find(
        (call: string[]) => call[0] === 'auth_refresh',
      )?.[1] as (payload: AuthRefreshPayload) => Promise<void>;

      expect(authRefreshHandler).toBeDefined();

      (authService.verifyToken as jest.Mock).mockImplementation(() => {
        throw new Error('Invalid token');
      });

      await authRefreshHandler({ token: 'bad-token' });

      expect(socket.emit).toHaveBeenCalledWith('auth_refresh_ack', {
        success: false,
        error: 'Invalid token',
      } as AuthRefreshAckPayload);
    });

    it('cleans up interval on disconnect', async () => {
      socket.data.token = 'valid-token';
      socket.data.userId = 'user-1';

      (socketService.validateSocketToken as jest.Mock).mockResolvedValue(true);

      registerLocationHandler(io, socket);

      jest.advanceTimersByTime(5_000);
      await Promise.resolve();
      expect(socketService.validateSocketToken).toHaveBeenCalledTimes(1);

      // Simulate disconnect
      const disconnectHandler = (socket.on as jest.Mock).mock.calls.find(
        (call: string[]) => call[0] === 'disconnect',
      )?.[1] as () => void;

      expect(disconnectHandler).toBeDefined();
      disconnectHandler!();

      jest.advanceTimersByTime(60_000);
      await Promise.resolve();
      // Should not have been called again after cleanup
      expect(socketService.validateSocketToken).toHaveBeenCalledTimes(1);
    });
  });

  describe('deliveryRoom helper', () => {
    it('prefixes the deliveryId with DELIVERY_ROOM_PREFIX', () => {
      expect(deliveryRoom('abc123')).toBe('delivery:abc123');
    });

    it('produces a unique room per deliveryId', () => {
      const a = 'delivery-a';
      const b = 'delivery-b';
      expect(deliveryRoom(a)).not.toBe(deliveryRoom(b));
    });
  });
});
