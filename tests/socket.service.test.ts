/**
 * Unit tests for SocketService
 *
 * Tests cover:
 *   - registerConnection
 *   - handlePong
 *   - handleDisconnect
 *   - trackRoomJoin / trackRoomLeave
 *   - runHealthCheckTick (ping dispatch & stale eviction)
 *   - startHealthChecks / stopHealthChecks
 */

import { SocketService } from '../src/sockets/socket.service';
import { TypedSocket } from '../src/sockets/socket.types';

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Silence logger output during tests
jest.mock('../src/config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

// Mock authService for token validation tests
jest.mock('../src/services/authService', () => ({
  verifyToken: jest.fn(),
  getUserById: jest.fn(),
}));

import authService from '../src/services/authService';

/**
 * Build a minimal mock TypedSocket with only the fields the service needs.
 */
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
    rooms: new Set([id]),
  } as unknown as jest.Mocked<TypedSocket>;
}

/**
 * Build a minimal mock Socket.IO server whose `sockets.sockets` map mirrors
 * whatever we put in it.
 */
function makeMockIO(
  socketMap: Map<string, jest.Mocked<TypedSocket>>,
): Parameters<SocketService['runHealthCheckTick']>[0] {
  return {
    sockets: {
      sockets: socketMap,
    },
  } as unknown as Parameters<SocketService['runHealthCheckTick']>[0];
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SocketService', () => {
  let service: SocketService;

  beforeEach(() => {
    service = new SocketService();
    jest.useFakeTimers();
  });

  afterEach(() => {
    service.stopHealthChecks();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  // ── registerConnection ─────────────────────────────────────────────────────

  describe('registerConnection', () => {
    it('tracks a new connection', () => {
      const socket = makeMockSocket('socket-1');
      service.registerConnection(socket, 'user-abc');

      expect(service.getConnectionCount()).toBe(1);
    });

    it('records userId and initial rooms', () => {
      const socket = makeMockSocket('socket-2');
      service.registerConnection(socket, 'user-xyz');

      const connections = service.getConnections();
      const meta = connections.get('socket-2');

      expect(meta).toBeDefined();
      expect(meta!.userId).toBe('user-xyz');
      expect(meta!.rooms).toContain('socket-2');
    });

    it('registers anonymous connections (no userId)', () => {
      const socket = makeMockSocket('socket-anon');
      service.registerConnection(socket);

      const meta = service.getConnections().get('socket-anon');
      expect(meta!.userId).toBeUndefined();
    });

    it('increments connection count for multiple sockets', () => {
      service.registerConnection(makeMockSocket('s1'));
      service.registerConnection(makeMockSocket('s2'));
      service.registerConnection(makeMockSocket('s3'));

      expect(service.getConnectionCount()).toBe(3);
    });
  });

  // ── handlePong ─────────────────────────────────────────────────────────────

  describe('handlePong', () => {
    it('resets missedPongs to 0', () => {
      const socket = makeMockSocket('socket-p1');
      service.registerConnection(socket);

      // Manually bump missedPongs
      const meta = service.getConnections().get('socket-p1')!;
      meta.missedPongs = 2;

      service.handlePong(socket, { timestamp: Date.now() });

      expect(meta.missedPongs).toBe(0);
    });

    it('updates lastPongAt', () => {
      const socket = makeMockSocket('socket-p2');
      service.registerConnection(socket);

      const before = service.getConnections().get('socket-p2')!.lastPongAt;
      jest.advanceTimersByTime(500);

      service.handlePong(socket, { timestamp: Date.now() - 500 });

      const after = service.getConnections().get('socket-p2')!.lastPongAt;
      expect(after).toBeGreaterThanOrEqual(before);
    });

    it('warns and does not throw for unknown socket', () => {
      const unknownSocket = makeMockSocket('ghost-socket');
      // Not registered — should not throw
      expect(() => service.handlePong(unknownSocket, { timestamp: Date.now() })).not.toThrow();
    });
  });

  // ── handleDisconnect ───────────────────────────────────────────────────────

  describe('handleDisconnect', () => {
    it('removes the connection on disconnect', () => {
      const socket = makeMockSocket('socket-d1');
      service.registerConnection(socket, 'user-1');

      service.handleDisconnect(socket, 'transport close');

      expect(service.getConnectionCount()).toBe(0);
      expect(service.getConnections().get('socket-d1')).toBeUndefined();
    });

    it('does not throw when disconnecting an untracked socket', () => {
      const socket = makeMockSocket('ghost-d2');
      expect(() => service.handleDisconnect(socket, 'server namespace disconnect')).not.toThrow();
    });
  });

  // ── trackRoomJoin / trackRoomLeave ─────────────────────────────────────────

  describe('room tracking', () => {
    it('adds a room on join', () => {
      const socket = makeMockSocket('socket-r1');
      service.registerConnection(socket);

      service.trackRoomJoin('socket-r1', 'delivery:42');

      const meta = service.getConnections().get('socket-r1')!;
      expect(meta.rooms).toContain('delivery:42');
    });

    it('does not duplicate rooms', () => {
      const socket = makeMockSocket('socket-r2');
      service.registerConnection(socket);

      service.trackRoomJoin('socket-r2', 'delivery:42');
      service.trackRoomJoin('socket-r2', 'delivery:42');

      const meta = service.getConnections().get('socket-r2')!;
      expect(meta.rooms.filter((r: string) => r === 'delivery:42')).toHaveLength(1);
    });

    it('removes a room on leave', () => {
      const socket = makeMockSocket('socket-r3');
      service.registerConnection(socket);
      service.trackRoomJoin('socket-r3', 'delivery:99');

      service.trackRoomLeave('socket-r3', 'delivery:99');

      const meta = service.getConnections().get('socket-r3')!;
      expect(meta.rooms).not.toContain('delivery:99');
    });

    it('is a no-op for unknown socket IDs', () => {
      expect(() => service.trackRoomJoin('no-such-socket', 'room-x')).not.toThrow();
      expect(() => service.trackRoomLeave('no-such-socket', 'room-x')).not.toThrow();
    });
  });

  // ── runHealthCheckTick ─────────────────────────────────────────────────────

  describe('runHealthCheckTick', () => {
    it('emits a ping to every active socket', () => {
      const s1 = makeMockSocket('tick-s1');
      const s2 = makeMockSocket('tick-s2');
      service.registerConnection(s1);
      service.registerConnection(s2);

      const socketMap = new Map([
        ['tick-s1', s1],
        ['tick-s2', s2],
      ]);
      const io = makeMockIO(socketMap);

      service.runHealthCheckTick(io);

      expect(s1.emit).toHaveBeenCalledWith(
        'ping',
        expect.objectContaining({ timestamp: expect.any(Number) }),
      );
      expect(s2.emit).toHaveBeenCalledWith(
        'ping',
        expect.objectContaining({ timestamp: expect.any(Number) }),
      );
    });

    it('increments missedPongs each tick when no pong is received', () => {
      const socket = makeMockSocket('tick-stale');
      service.registerConnection(socket);

      const io = makeMockIO(new Map([['tick-stale', socket]]));

      service.runHealthCheckTick(io);
      const meta = service.getConnections().get('tick-stale')!;
      expect(meta.missedPongs).toBe(1);

      service.runHealthCheckTick(io);
      expect(meta.missedPongs).toBe(2);
    });

    it('disconnects a socket that exceeds MAX_MISSED_PONGS (default 2)', () => {
      const socket = makeMockSocket('tick-evict');
      service.registerConnection(socket);

      const io = makeMockIO(new Map([['tick-evict', socket]]));

      // tick 1 → missedPongs = 1, below threshold → ping emitted
      service.runHealthCheckTick(io);
      expect(socket.disconnect).not.toHaveBeenCalled();

      // tick 2 → missedPongs = 2, still at threshold → ping emitted
      service.runHealthCheckTick(io);
      expect(socket.disconnect).not.toHaveBeenCalled();

      // tick 3 → missedPongs = 3, exceeds threshold → disconnect
      service.runHealthCheckTick(io);
      expect(socket.disconnect).toHaveBeenCalledWith(true);
    });

    it('returns a HealthCheckResult with correct counts', () => {
      const socket = makeMockSocket('tick-result');
      service.registerConnection(socket);

      const io = makeMockIO(new Map([['tick-result', socket]]));
      const result = service.runHealthCheckTick(io);

      expect(result).toMatchObject({
        checkedAt: expect.any(String),
        totalConnections: expect.any(Number),
        staleConnectionsEvicted: expect.any(Number),
        activeConnections: expect.any(Number),
      });
    });

    it('cleans up the record for a socket that is already gone at transport level', () => {
      const socket = makeMockSocket('tick-gone');
      service.registerConnection(socket);

      // Simulate 3 ticks without the socket being present in io.sockets.sockets
      const emptyIO = makeMockIO(new Map()); // socket not in the server map

      service.runHealthCheckTick(emptyIO); // missedPongs = 1
      service.runHealthCheckTick(emptyIO); // missedPongs = 2
      service.runHealthCheckTick(emptyIO); // missedPongs = 3 → evicted from registry

      expect(service.getConnections().get('tick-gone')).toBeUndefined();
    });
  });

  // ── startHealthChecks / stopHealthChecks ───────────────────────────────────

  describe('health check loop', () => {
    it('starts and stops without error', () => {
      const io = makeMockIO(new Map());

      expect(() => service.startHealthChecks(io)).not.toThrow();
      expect(() => service.stopHealthChecks()).not.toThrow();
    });

    it('does not start a second loop when already running', () => {
      const io = makeMockIO(new Map());
      service.startHealthChecks(io);

      // Calling a second time should warn but not throw
      expect(() => service.startHealthChecks(io)).not.toThrow();

      service.stopHealthChecks();
    });

    it('invokes runHealthCheckTick on each interval tick', () => {
      const socket = makeMockSocket('loop-s1');
      service.registerConnection(socket);

      const io = makeMockIO(new Map([['loop-s1', socket]]));
      service.startHealthChecks(io);

      jest.advanceTimersByTime(25_000); // one tick
      expect(socket.emit).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(25_000); // second tick
      expect(socket.emit).toHaveBeenCalledTimes(2);

      service.stopHealthChecks();
    });
  });

  // ── validateSocketToken ─────────────────────────────────────────────────────

  describe('validateSocketToken', () => {
    it('returns true when socket has no token or userId', async () => {
      const socket = makeMockSocket('no-token');
      const result = await service.validateSocketToken(socket);
      expect(result).toBe(true);
    });

    it('returns true for a valid token with an active user', async () => {
      const socket = makeMockSocket('valid-token');
      socket.data.token = 'valid-token';
      socket.data.userId = 'user-1';

      (authService.verifyToken as jest.Mock).mockReturnValue({ userId: 'user-1' });
      (authService.getUserById as jest.Mock).mockResolvedValue({ status: 'active' });

      const result = await service.validateSocketToken(socket);
      expect(result).toBe(true);
      expect(authService.verifyToken).toHaveBeenCalledWith('valid-token');
      expect(authService.getUserById).toHaveBeenCalledWith('user-1');
    });

    it('returns false for an expired or invalid token', async () => {
      const socket = makeMockSocket('expired-token');
      socket.data.token = 'expired-token';
      socket.data.userId = 'user-1';

      (authService.verifyToken as jest.Mock).mockImplementation(() => {
        throw new Error('Token expired');
      });

      const result = await service.validateSocketToken(socket);
      expect(result).toBe(false);
    });

    it('returns false when the user does not exist', async () => {
      const socket = makeMockSocket('no-user');
      socket.data.token = 'valid-token';
      socket.data.userId = 'user-missing';

      (authService.verifyToken as jest.Mock).mockReturnValue({ userId: 'user-missing' });
      (authService.getUserById as jest.Mock).mockResolvedValue(null);

      const result = await service.validateSocketToken(socket);
      expect(result).toBe(false);
    });

    it('returns false for a suspended user', async () => {
      const socket = makeMockSocket('suspended-user');
      socket.data.token = 'valid-token';
      socket.data.userId = 'user-suspended';

      (authService.verifyToken as jest.Mock).mockReturnValue({ userId: 'user-suspended' });
      (authService.getUserById as jest.Mock).mockResolvedValue({ status: 'suspended' });

      const result = await service.validateSocketToken(socket);
      expect(result).toBe(false);
    });

    it('returns false for a banned user', async () => {
      const socket = makeMockSocket('banned-user');
      socket.data.token = 'valid-token';
      socket.data.userId = 'user-banned';

      (authService.verifyToken as jest.Mock).mockReturnValue({ userId: 'user-banned' });
      (authService.getUserById as jest.Mock).mockResolvedValue({ status: 'banned' });

      const result = await service.validateSocketToken(socket);
      expect(result).toBe(false);
    });
  });
});
