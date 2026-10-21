import { randomUUID } from 'crypto';
import env from '../config/env';
import logger from '../config/logger';

/**
 * Callback handed to an emitter so the client can acknowledge receipt.
 * A message is only removed from the queue when this is invoked with a
 * non-null/non-undefined value (an empty object counts as an ACK).
 */
export type MessageAckCallback = (ack?: unknown) => void;

/**
 * Emitter signature used to (re)deliver a queued message to a client.
 * Matches the subset of `Socket.emit` the queue relies on.
 */
export type MessageEmitter<T = unknown> = (
  event: string,
  payload: T,
  ackCallback?: MessageAckCallback,
) => void;

/**
 * A single message tracked by the delivery-guarantee queue.
 */
export interface QueuedSocketMessage<T = unknown> {
  id: string;
  userId: string;
  event: string;
  payload: T;
  queuedAt: number;
  updatedAt: number;
  /** When true the message is retained until the client ACKs it. */
  ackRequired: boolean;
  /** Number of automatic re-deliveries performed after ACK timeouts. */
  retries: number;
  ackTimeoutMs: number;
  /** Upper bound on automatic re-deliveries before retrying is paused. */
  maxRetries: number;
  /**
   * Connection generation this message was last delivered on, or `null` when
   * it has not yet been delivered on the current connection. Used to make
   * reconnects idempotent (see {@link MessageQueueService.flush}).
   */
  deliveredConnectionId: number | null;
  /**
   * Delivery lifecycle:
   *   - `pending`   – awaiting its first/next delivery attempt.
   *   - `in-flight` – delivered, awaiting an ACK (a timer is armed).
   *   - `exhausted` – retry budget spent; retained for the next reconnect.
   */
  status: 'pending' | 'in-flight' | 'exhausted';
  /** Timestamp (ms epoch) of the most recent delivery attempt, if any. */
  lastAttemptAt: number | null;
}

export interface EnqueueSocketMessageOptions<T = unknown> {
  ackRequired?: boolean;
  ackTimeoutMs?: number;
  /** Overrides the configured automatic retry budget for this message. */
  maxRetries?: number;
  payload?: T;
}

export interface MessageQueueOptions {
  /** Default ACK timeout applied when an enqueue call omits one. */
  defaultAckTimeoutMs?: number;
  /** Per-driver queue bound; oldest messages are evicted past this size. */
  maxQueueSize?: number;
  /** Default automatic retry budget for queued messages. */
  maxRetries?: number;
}

/**
 * In-memory offline message queue providing at-least-once delivery for
 * driver-bound socket messages.
 *
 * Delivery-guarantee invariants:
 *   1. **ACK gating** – an ACK-required message is never removed from its
 *      driver's queue until the client ACKs it or a fixed bound evicts it.
 *   2. **Timeout/retry** – each delivery arms a timer; if no ACK arrives
 *      within `ackTimeoutMs` the message is re-delivered, up to `maxRetries`.
 *      Once the budget is spent the message is *retained* (`exhausted`),
 *      never silently dropped, so a later reconnect can still flush it.
 *   3. **Bounded persistence** – at most `maxQueueSize` unacknowledged
 *      messages are retained per driver; the oldest is evicted, so an
 *      abusive or permanently-offline client cannot grow memory unboundedly.
 *   4. **Idempotent reconnect flush** – {@link flush} only emits messages not
 *      already in-flight on the *same* connection generation. Re-delivery
 *      across a genuine reconnect happens exactly once, and an ACKed message
 *      is never re-sent.
 *   5. **Per-driver isolation** – queues, timers, emitters and ACKs are keyed
 *      by `userId`; acknowledging one driver never touches another.
 *   6. **Disconnect safety** – {@link handleDisconnect} drops the dead
 *      emitter, stops its timers and rewinds in-flight messages to `pending`
 *      so they are flushed when the driver reconnects.
 */
export class MessageQueueService {
  private readonly queues = new Map<string, QueuedSocketMessage[]>();
  /** Armed ACK-timeout timers, keyed by `${userId}\u0000${messageId}`. */
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Most recent delivery target per driver, used to perform retries. */
  private readonly emitters = new Map<string, MessageEmitter>();
  /** Active connection generation per driver. */
  private readonly activeConnectionId = new Map<string, number>();
  /** Stable connection generations for emitter/socket owners. */
  private readonly connectionIds = new WeakMap<object, number>();
  private connectionSeq = 0;

  private readonly defaultAckTimeoutMs: number;
  private readonly maxQueueSize: number;
  private readonly maxRetries: number;

  constructor(options: MessageQueueOptions = {}) {
    this.defaultAckTimeoutMs = options.defaultAckTimeoutMs ?? env.SOCKET_MESSAGE_ACK_TIMEOUT_MS;
    this.maxQueueSize = options.maxQueueSize ?? env.SOCKET_MESSAGE_QUEUE_MAX;
    this.maxRetries = options.maxRetries ?? env.SOCKET_MESSAGE_MAX_RETRIES;
  }

  /**
   * Queue a message for a driver.
   *
   * The message is retained until it is ACKed (when `ackRequired`), retried
   * past its ACK timeout, or evicted by the per-driver bound. Enqueuing never
   * emits; delivery happens through {@link flush} or {@link sendWithAck}.
   */
  public enqueue<T = unknown>(
    userId: string,
    event: string,
    payload: T,
    options: EnqueueSocketMessageOptions<T> = {},
  ): QueuedSocketMessage<T> {
    const normalizedUserId = userId?.trim();
    if (!normalizedUserId) {
      throw new Error('userId is required to queue a socket message');
    }
    if (!event?.trim()) {
      throw new Error('event name is required to queue a socket message');
    }

    const queuedAt = Date.now();
    const queued: QueuedSocketMessage<T> = {
      id: randomUUID(),
      userId: normalizedUserId,
      event,
      payload,
      queuedAt,
      updatedAt: queuedAt,
      ackRequired: options.ackRequired ?? true,
      retries: 0,
      ackTimeoutMs: options.ackTimeoutMs ?? this.defaultAckTimeoutMs,
      maxRetries: options.maxRetries ?? this.maxRetries,
      deliveredConnectionId: null,
      status: 'pending',
      lastAttemptAt: null,
    };

    const existing = this.queues.get(normalizedUserId) ?? [];

    // Bound the queue: evict the oldest messages so a permanently-offline or
    // abusive client cannot grow memory without limit.
    while (existing.length >= this.maxQueueSize) {
      const evicted = existing.shift();
      if (evicted) {
        this.clearTimer(normalizedUserId, evicted.id);
        logger.warn(
          `[MessageQueue] Evicted oldest message for userId=${normalizedUserId} ` +
            `messageId=${evicted.id} event=${evicted.event} (bound=${this.maxQueueSize})`,
        );
      }
    }

    existing.push(queued);
    this.queues.set(normalizedUserId, existing);

    return queued;
  }

  /** Return a copy of a driver's pending/unacknowledged messages. */
  public getPending(userId: string): QueuedSocketMessage[] {
    const queue = this.queues.get(userId?.trim() ?? '');
    return queue ? [...queue] : [];
  }

  /**
   * Remove a single message after the client acknowledged it.
   *
   * @returns `true` when a matching message was found and removed.
   */
  public acknowledge(userId: string, messageId: string): boolean {
    const normalizedUserId = userId?.trim();
    const queue = normalizedUserId ? this.queues.get(normalizedUserId) : undefined;

    if (!queue || queue.length === 0) {
      return false;
    }

    const index = queue.findIndex((message) => message.id === messageId);
    if (index < 0) {
      return false;
    }

    queue.splice(index, 1);
    this.clearTimer(normalizedUserId as string, messageId);

    if (queue.length === 0) {
      this.queues.delete(normalizedUserId as string);
    }

    return true;
  }

  /**
   * Deliver every unacknowledged message for a driver to the given emitter.
   *
   * Idempotent within a connection: messages already delivered (and awaiting
   * an ACK) on the same connection generation are skipped, so calling this
   * twice for one socket cannot double-deliver. A genuine reconnect resolves
   * to a new connection generation, so previously in-flight messages are
   * re-delivered exactly once.
   *
   * @param userId  - Driver whose queue should be flushed.
   * @param emit    - Delivery function (typically `socket.emit`).
   * @param owner   - Stable identity for the connection (e.g. the socket).
   *                  Defaults to `emit`; pass the socket so {@link sendWithAck}
   *                  and reconnect flushes share one generation.
   * @returns         Number of messages emitted during this call.
   */
  public flush<T = unknown>(userId: string, emit: MessageEmitter<T>, owner?: object): number {
    const normalizedUserId = userId?.trim();
    const queue = normalizedUserId ? this.queues.get(normalizedUserId) : undefined;

    if (!normalizedUserId || !queue || queue.length === 0) {
      return 0;
    }

    const connectionId = this.resolveConnectionId(owner ?? emit);
    this.emitters.set(normalizedUserId, emit as MessageEmitter);
    this.activeConnectionId.set(normalizedUserId, connectionId);

    const pending = [...queue];
    let delivered = 0;

    for (const message of pending) {
      // Skip anything already in-flight (or exhausted) on this connection.
      if (message.deliveredConnectionId === connectionId) {
        continue;
      }

      this.deliver(normalizedUserId, message, emit as MessageEmitter, connectionId);
      delivered += 1;
    }

    return delivered;
  }

  /**
   * Queue and immediately deliver a message to a live socket, arming the
   * ACK-timeout retry loop. Returns the queued record, or `null` when the
   * socket is not associated with an authenticated driver.
   */
  public sendWithAck<T = unknown>(
    socket: {
      data?: { userId?: string };
      emit: (event: string, payload: T, ack?: MessageAckCallback) => void;
    },
    event: string,
    payload: T,
  ): QueuedSocketMessage<T> | null {
    const userId = socket?.data?.userId?.trim();
    if (!userId) {
      return null;
    }

    const queued = this.enqueue(userId, event, payload, { ackRequired: true });

    const emit = socket.emit as MessageEmitter<T>;
    const connectionId = this.resolveConnectionId(socket);

    this.emitters.set(userId, emit as MessageEmitter);
    this.activeConnectionId.set(userId, connectionId);
    this.deliver(userId, queued, emit as MessageEmitter, connectionId);

    return queued;
  }

  /**
   * Handle a driver disconnect: drop the dead emitter, cancel pending retry
   * timers and rewind in-flight messages to `pending` so they are flushed on
   * reconnect. Safe to call for unknown/anonymous users.
   *
   * @returns Number of messages rewound to `pending`.
   */
  public handleDisconnect(userId?: string): number {
    const normalizedUserId = userId?.trim();
    if (!normalizedUserId) {
      return 0;
    }

    this.emitters.delete(normalizedUserId);
    this.activeConnectionId.delete(normalizedUserId);

    const queue = this.queues.get(normalizedUserId);
    if (!queue || queue.length === 0) {
      return 0;
    }

    let rewound = 0;
    for (const message of queue) {
      this.clearTimer(normalizedUserId, message.id);
      if (message.status === 'in-flight') {
        message.status = 'pending';
        message.deliveredConnectionId = null;
        message.updatedAt = Date.now();
        rewound += 1;
      }
    }

    return rewound;
  }

  /**
   * Drop queued messages (and their timers) for one driver, or for every
   * driver when `userId` is omitted.
   *
   * @returns Number of messages removed.
   */
  public clear(userId?: string): number {
    if (!userId) {
      let total = 0;
      for (const queue of this.queues.values()) {
        total += queue.length;
        for (const message of queue) {
          this.clearTimer(message.userId, message.id);
        }
      }
      this.queues.clear();
      this.emitters.clear();
      this.activeConnectionId.clear();
      return total;
    }

    const normalizedUserId = userId.trim();
    const queue = this.queues.get(normalizedUserId);
    const size = queue?.length ?? 0;

    if (queue) {
      for (const message of queue) {
        this.clearTimer(normalizedUserId, message.id);
      }
      this.queues.delete(normalizedUserId);
    }

    this.emitters.delete(normalizedUserId);
    this.activeConnectionId.delete(normalizedUserId);

    return size;
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  /** Emit one message and arm its ACK timeout (when an ACK is required). */
  private deliver<T = unknown>(
    userId: string,
    message: QueuedSocketMessage<T>,
    emit: MessageEmitter,
    connectionId: number | null,
  ): void {
    const now = Date.now();
    message.updatedAt = now;
    message.lastAttemptAt = now;
    message.deliveredConnectionId = connectionId;

    // Fire-and-forget messages carry no ACK contract, so retain nothing.
    if (!message.ackRequired) {
      emit(message.event, message.payload);
      this.acknowledge(userId, message.id);
      return;
    }

    message.status = 'in-flight';
    emit(message.event, message.payload, (ack?: unknown) => {
      if (ack !== undefined && ack !== null) {
        this.acknowledge(userId, message.id);
      }
    });

    this.armAckTimer(userId, message);
  }

  /** (Re)arm the ACK-timeout timer for a message. */
  private armAckTimer(userId: string, message: QueuedSocketMessage): void {
    if (!message.ackRequired || message.ackTimeoutMs <= 0) {
      return;
    }

    this.clearTimer(userId, message.id);

    const timer = setTimeout(() => {
      this.handleAckTimeout(userId, message.id);
    }, message.ackTimeoutMs);

    // Never let a retry timer keep the process alive on its own.
    (timer as { unref?: () => void }).unref?.();

    this.timers.set(this.timerKey(userId, message.id), timer);
  }

  /** Called when a message's ACK window elapses without acknowledgement. */
  private handleAckTimeout(userId: string, messageId: string): void {
    this.timers.delete(this.timerKey(userId, messageId));

    const message = this.queues.get(userId)?.find((m) => m.id === messageId);
    if (!message || !message.ackRequired || message.status === 'exhausted') {
      return;
    }

    if (message.retries >= message.maxRetries) {
      // Budget spent: keep the message for the next reconnect flush instead
      // of dropping it, but stop the automatic retry loop.
      message.status = 'exhausted';
      message.updatedAt = Date.now();
      logger.warn(
        `[MessageQueue] Retry budget exhausted for userId=${userId} ` +
          `messageId=${messageId} retries=${message.retries}`,
      );
      return;
    }

    const emit = this.emitters.get(userId);
    if (!emit) {
      // Driver is offline: park the message until the next reconnect flush.
      message.status = 'pending';
      message.deliveredConnectionId = null;
      return;
    }

    message.retries += 1;
    logger.debug(
      `[MessageQueue] ACK timeout — retrying userId=${userId} ` +
        `messageId=${messageId} attempt=${message.retries}/${message.maxRetries}`,
    );

    this.deliver(userId, message, emit, this.activeConnectionId.get(userId) ?? null);
  }

  private timerKey(userId: string, messageId: string): string {
    return `${userId}\u0000${messageId}`;
  }

  private clearTimer(userId: string, messageId: string): void {
    const key = this.timerKey(userId, messageId);
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
  }

  private resolveConnectionId(owner: object): number {
    let id = this.connectionIds.get(owner);
    if (id === undefined) {
      id = ++this.connectionSeq;
      this.connectionIds.set(owner, id);
    }
    return id;
  }
}

/** Singleton instance shared across the sockets layer. */
export const messageQueueService = new MessageQueueService();
