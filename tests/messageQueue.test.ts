import { MessageQueueService } from '../src/sockets/messageQueue';

// Silence the queue's own logging during tests.
jest.mock('../src/config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

describe('MessageQueueService', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  // ── Core ACK gating ────────────────────────────────────────────────────────

  it('queues a message for a driver and keeps it pending until ack', () => {
    const service = new MessageQueueService();

    const queued = service.enqueue('driver-123', 'delivery:status', { deliveryId: 'abc' });

    expect(queued.userId).toBe('driver-123');
    expect(queued.ackRequired).toBe(true);
    expect(queued.status).toBe('pending');
    expect(service.getPending('driver-123')).toHaveLength(1);
    expect(service.acknowledge('driver-123', queued.id)).toBe(true);
    expect(service.getPending('driver-123')).toHaveLength(0);
  });

  it('flushes queued messages to a newly reconnected socket', () => {
    const service = new MessageQueueService();
    const sent: Array<{ event: string; payload: unknown }> = [];

    service.enqueue('driver-456', 'delivery:status', { deliveryId: 'xyz' });

    const flushed = service.flush('driver-456', (event, payload) => {
      sent.push({ event, payload });
    });

    expect(flushed).toBe(1);
    expect(sent).toEqual([{ event: 'delivery:status', payload: { deliveryId: 'xyz' } }]);
  });

  it('removes a queued message when the client acknowledges it', () => {
    const service = new MessageQueueService();

    const queued = service.enqueue('driver-789', 'delivery:status', { deliveryId: 'ready' });
    service.acknowledge('driver-789', queued.id);

    expect(service.getPending('driver-789')).toHaveLength(0);
  });

  it('removes a message when the emit ack callback is invoked', () => {
    const service = new MessageQueueService();
    const emit = jest.fn();

    service.enqueue('driver-ack-cb', 'delivery:status', { deliveryId: 'ready' });
    service.flush('driver-ack-cb', emit);

    const ackCallback = emit.mock.calls[0][2] as (ack?: unknown) => void;
    ackCallback({ ok: true });

    expect(service.getPending('driver-ack-cb')).toHaveLength(0);
  });

  // ── Idempotent flush / reconnect ───────────────────────────────────────────

  it('does not re-deliver an in-flight message when flush is repeated on the same connection', () => {
    const service = new MessageQueueService();
    const emit = jest.fn();

    service.enqueue('driver-idem', 'delivery:status', { deliveryId: 'a' });

    expect(service.flush('driver-idem', emit)).toBe(1);
    // Same emit function => same connection generation => no duplicate delivery.
    expect(service.flush('driver-idem', emit)).toBe(0);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('flushes unacked messages exactly once on reconnect (no duplicates, acked skipped)', () => {
    const service = new MessageQueueService();
    const firstConnection = jest.fn();
    const reconnected = jest.fn();

    const first = service.enqueue('driver-reconnect', 'delivery:status', { n: 1 });
    service.enqueue('driver-reconnect', 'delivery:status', { n: 2 });

    expect(service.flush('driver-reconnect', firstConnection)).toBe(2);

    // Driver acks only the first message while still connected.
    expect(service.acknowledge('driver-reconnect', first.id)).toBe(true);

    // Reconnect: only the unacked message is re-delivered.
    expect(service.flush('driver-reconnect', reconnected)).toBe(1);
    expect(reconnected).toHaveBeenCalledTimes(1);
    expect(reconnected.mock.calls[0][1]).toEqual({ n: 2 });

    // A repeated flush on the same reconnect must not duplicate.
    expect(service.flush('driver-reconnect', reconnected)).toBe(0);
    expect(reconnected).toHaveBeenCalledTimes(1);
  });

  // ── ACK timeout / retry ────────────────────────────────────────────────────

  it('retries a message when its ACK timeout elapses', () => {
    jest.useFakeTimers();
    const service = new MessageQueueService({ defaultAckTimeoutMs: 1000, maxRetries: 3 });
    const emit = jest.fn();

    service.enqueue('driver-retry', 'delivery:status', { deliveryId: 'r' });
    service.flush('driver-retry', emit);
    expect(emit).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(1000);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(service.getPending('driver-retry')[0].retries).toBe(1);
  });

  it('stops retrying once the budget is exhausted but keeps the message for reconnect', () => {
    jest.useFakeTimers();
    const service = new MessageQueueService({ defaultAckTimeoutMs: 500, maxRetries: 1 });
    const emit = jest.fn();

    service.enqueue('driver-exhaust', 'delivery:status', { deliveryId: 'x' });
    service.flush('driver-exhaust', emit);

    jest.advanceTimersByTime(500); // one retry
    expect(emit).toHaveBeenCalledTimes(2);

    jest.advanceTimersByTime(500 * 10); // budget spent, no further retries
    expect(emit).toHaveBeenCalledTimes(2);

    const [pending] = service.getPending('driver-exhaust');
    expect(pending.status).toBe('exhausted');

    // A reconnect still flushes the retained message exactly once.
    const reconnected = jest.fn();
    expect(service.flush('driver-exhaust', reconnected)).toBe(1);
    expect(reconnected).toHaveBeenCalledTimes(1);
  });

  it('cancels the retry timer when a message is acknowledged', () => {
    jest.useFakeTimers();
    const service = new MessageQueueService({ defaultAckTimeoutMs: 1000 });
    const emit = jest.fn((_event: string, _payload: unknown, ack?: (ack?: unknown) => void) => {
      ack?.({ ok: true });
    });

    service.enqueue('driver-ack-timer', 'delivery:status', { deliveryId: 't' });
    service.flush('driver-ack-timer', emit);

    expect(service.getPending('driver-ack-timer')).toHaveLength(0);

    jest.advanceTimersByTime(10_000);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  // ── Bounded queue / eviction ───────────────────────────────────────────────

  it('evicts the oldest message when the per-driver bound is exceeded', () => {
    const service = new MessageQueueService({ maxQueueSize: 3 });

    const oldest = service.enqueue('driver-bounded', 'delivery:status', { n: 1 });
    service.enqueue('driver-bounded', 'delivery:status', { n: 2 });
    service.enqueue('driver-bounded', 'delivery:status', { n: 3 });
    service.enqueue('driver-bounded', 'delivery:status', { n: 4 });

    const pending = service.getPending('driver-bounded');
    expect(pending).toHaveLength(3);
    expect(pending.map((m) => m.payload)).toEqual([{ n: 2 }, { n: 3 }, { n: 4 }]);
    expect(pending.some((m) => m.id === oldest.id)).toBe(false);
  });

  // ── Per-driver isolation ───────────────────────────────────────────────────

  it('isolates queues, acks and flushes per driver', () => {
    const service = new MessageQueueService();

    const driverA = service.enqueue('driver-A', 'delivery:status', { n: 'a' });
    service.enqueue('driver-B', 'delivery:status', { n: 'b' });

    // A cross-driver ack must not remove another driver's message.
    expect(service.acknowledge('driver-B', driverA.id)).toBe(false);
    expect(service.getPending('driver-B')).toHaveLength(1);

    const emitA = jest.fn();
    expect(service.flush('driver-A', emitA)).toBe(1);
    expect(service.flush('driver-B', jest.fn())).toBe(1);

    expect(service.acknowledge('driver-A', driverA.id)).toBe(true);
    expect(service.getPending('driver-A')).toHaveLength(0);
    expect(service.getPending('driver-B')).toHaveLength(1);
  });

  // ── Disconnect safety ──────────────────────────────────────────────────────

  it('rewinds in-flight messages on disconnect and flushes them on reconnect', () => {
    jest.useFakeTimers();
    const service = new MessageQueueService({ defaultAckTimeoutMs: 1000 });
    const deadSocket = jest.fn();

    service.enqueue('driver-offline', 'delivery:status', { n: 1 });
    service.flush('driver-offline', deadSocket);

    expect(service.handleDisconnect('driver-offline')).toBe(1);
    expect(service.getPending('driver-offline')[0].status).toBe('pending');

    // A pending timer must not deliver into the disconnected socket.
    jest.advanceTimersByTime(1000);
    expect(deadSocket).toHaveBeenCalledTimes(1);

    const reconnected = jest.fn();
    expect(service.flush('driver-offline', reconnected)).toBe(1);
    expect(reconnected).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when disconnecting an unknown or anonymous user', () => {
    const service = new MessageQueueService();
    expect(service.handleDisconnect('nobody')).toBe(0);
    expect(service.handleDisconnect(undefined)).toBe(0);
    expect(() => service.handleDisconnect()).not.toThrow();
  });

  // ── sendWithAck helper ─────────────────────────────────────────────────────

  it('queues, delivers and retries a sendWithAck message to the same socket', () => {
    jest.useFakeTimers();
    const service = new MessageQueueService({ defaultAckTimeoutMs: 1000 });
    const socket = { data: { userId: 'driver-send' }, emit: jest.fn() };

    const queued = service.sendWithAck(socket, 'delivery:status', { n: 1 });

    expect(queued).not.toBeNull();
    expect(socket.emit).toHaveBeenCalledTimes(1);
    expect(service.getPending('driver-send')).toHaveLength(1);

    jest.advanceTimersByTime(1000); // retry to the same socket
    expect(socket.emit).toHaveBeenCalledTimes(2);

    const ackCallback = socket.emit.mock.calls[1][2] as (ack?: unknown) => void;
    ackCallback({ ok: true });
    expect(service.getPending('driver-send')).toHaveLength(0);

    jest.advanceTimersByTime(5000);
    expect(socket.emit).toHaveBeenCalledTimes(2);
  });

  it('returns null from sendWithAck for an unauthenticated socket', () => {
    const service = new MessageQueueService();
    const socket = { data: {}, emit: jest.fn() };

    expect(service.sendWithAck(socket, 'delivery:status', { n: 1 })).toBeNull();
  });

  // ── Validation & clear ─────────────────────────────────────────────────────

  it('rejects enqueue calls without a userId or event', () => {
    const service = new MessageQueueService();

    expect(() => service.enqueue('', 'delivery:status', {})).toThrow(/userId is required/);
    expect(() => service.enqueue('driver-x', '   ', {})).toThrow(/event name is required/);
  });

  it('clears a single driver queue or every queue', () => {
    const service = new MessageQueueService();
    service.enqueue('driver-1', 'e', { n: 1 });
    service.enqueue('driver-2', 'e', { n: 2 });

    expect(service.clear('driver-1')).toBe(1);
    expect(service.getPending('driver-1')).toHaveLength(0);
    expect(service.getPending('driver-2')).toHaveLength(1);

    expect(service.clear()).toBe(1);
    expect(service.getPending('driver-2')).toHaveLength(0);
  });
});
