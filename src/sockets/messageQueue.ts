import { randomUUID } from 'crypto';
import env from '../config/env';

export interface QueuedSocketMessage<T = unknown> {
  id: string;
  userId: string;
  event: string;
  payload: T;
  queuedAt: number;
  updatedAt: number;
  ackRequired: boolean;
  retries: number;
  ackTimeoutMs: number;
}

export interface EnqueueSocketMessageOptions<T = unknown> {
  ackRequired?: boolean;
  ackTimeoutMs?: number;
  payload?: T;
}

export class MessageQueueService {
  private readonly queues = new Map<string, QueuedSocketMessage[]>();
  private readonly defaultAckTimeoutMs = env.SOCKET_MESSAGE_ACK_TIMEOUT_MS;

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
    };

    const existing = this.queues.get(normalizedUserId) ?? [];
    existing.push(queued);
    this.queues.set(normalizedUserId, existing);

    return queued;
  }

  public getPending(userId: string): QueuedSocketMessage[] {
    const queue = this.queues.get(userId?.trim() ?? '');
    return queue ? [...queue] : [];
  }

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

    if (queue.length === 0) {
      this.queues.delete(normalizedUserId);
    }

    return true;
  }

  public flush<T = unknown>(
    userId: string,
    emit: (event: string, payload: T, ackCallback?: (ack?: unknown) => void) => void,
  ): number {
    const normalizedUserId = userId?.trim();
    const queue = normalizedUserId ? this.queues.get(normalizedUserId) : undefined;

    if (!queue || queue.length === 0) {
      return 0;
    }

    const pending = [...queue];

    for (const message of pending) {
      emit(message.event, message.payload as T, (ack?: unknown) => {
        if (ack !== undefined && ack !== null) {
          this.acknowledge(normalizedUserId, message.id);
        }
      });
    }

    return pending.length;
  }

  public sendWithAck<T = unknown>(
    socket: {
      data?: { userId?: string };
      emit: (event: string, payload: T, ack?: (ack?: unknown) => void) => void;
    },
    event: string,
    payload: T,
  ): QueuedSocketMessage<T> | null {
    const userId = socket?.data?.userId?.trim();
    if (!userId) {
      return null;
    }

    const queued = this.enqueue(userId, event, payload, { ackRequired: true });

    socket.emit(event, payload, (ack?: unknown) => {
      if (ack !== undefined && ack !== null) {
        this.acknowledge(userId, queued.id);
      }
    });

    return queued;
  }

  public clear(userId?: string): number {
    if (!userId) {
      const total = Array.from(this.queues.values()).reduce((sum, queue) => sum + queue.length, 0);
      this.queues.clear();
      return total;
    }

    const normalizedUserId = userId.trim();
    const queue = this.queues.get(normalizedUserId);
    const size = queue?.length ?? 0;

    if (queue) {
      this.queues.delete(normalizedUserId);
    }

    return size;
  }
}

export const messageQueueService = new MessageQueueService();
