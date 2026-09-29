/**
 * Unit tests for ChatMessageService and the socket transport adapter.
 *
 * The point of the refactor these cover is that the chat logic no longer needs
 * a running Socket.IO server to be tested: ChatMessageService is exercised
 * directly against a real in-process MongoDB, and the adapter is checked
 * against lightweight socket doubles that only record emitted events.
 */

import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Namespace, Socket } from 'socket.io';
import ChatMessage from '../src/models/ChatMessage';
import {
  ChatMessageService,
  InvalidChatMessageError,
  MAX_MESSAGE_LENGTH,
  RECENT_MESSAGE_LIMIT,
} from '../src/sockets/chatMessage.service';
import { SocketService } from '../src/sockets/socketService';

jest.mock('../src/config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

/** Records every event emitted to a single socket. */
const createSocketDouble = (): Socket & { emitted: Array<{ event: string; payload: unknown }> } => {
  const emitted: Array<{ event: string; payload: unknown }> = [];
  return {
    id: 'socket-test',
    emit: (event: string, payload: unknown) => {
      emitted.push({ event, payload });
      return true;
    },
    emitted,
  } as unknown as Socket & { emitted: Array<{ event: string; payload: unknown }> };
};

/** Records every event broadcast to a namespace. */
const createNamespaceDouble = (): Namespace & {
  emitted: Array<{ event: string; payload: unknown }>;
} => {
  const emitted: Array<{ event: string; payload: unknown }> = [];
  return {
    name: '/test',
    emit: (event: string, payload: unknown) => {
      emitted.push({ event, payload });
      return true;
    },
    emitted,
  } as unknown as Namespace & { emitted: Array<{ event: string; payload: unknown }> };
};

describe('ChatMessageService', () => {
  let mongod: MongoMemoryServer;
  let service: ChatMessageService;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    service = new ChatMessageService();
  }, 60_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  }, 30_000);

  afterEach(async () => {
    await ChatMessage.deleteMany({});
  });

  // ── Validation ────────────────────────────────────────────────────────────

  describe('validate', () => {
    it('accepts a well-formed message', () => {
      expect(service.validate({ content: 'hello', sender: 'ada' })).toEqual({
        content: 'hello',
        sender: 'ada',
      });
    });

    it('accepts a message with no sender', () => {
      expect(service.validate({ content: 'hello' })).toEqual({ content: 'hello' });
    });

    it('trims surrounding whitespace from the content', () => {
      expect(service.validate({ content: '  hello  ' }).content).toBe('hello');
    });

    it('omits a sender that is only whitespace', () => {
      expect(service.validate({ content: 'hi', sender: '   ' }).sender).toBeUndefined();
    });

    it.each([
      ['a null payload', null],
      ['an undefined payload', undefined],
      ['a string payload', 'hello'],
      ['a numeric payload', 42],
    ])('rejects %s', (_label, payload) => {
      expect(() => service.validate(payload as never)).toThrow(InvalidChatMessageError);
    });

    it('rejects a missing content field', () => {
      expect(() => service.validate({})).toThrow(/content is required/i);
    });

    it('rejects non-string content', () => {
      expect(() => service.validate({ content: 42 })).toThrow(/content is required/i);
    });

    it('rejects empty or whitespace-only content', () => {
      expect(() => service.validate({ content: '' })).toThrow(/cannot be empty/i);
      expect(() => service.validate({ content: '   ' })).toThrow(/cannot be empty/i);
    });

    it('rejects content over the length limit', () => {
      const tooLong = 'x'.repeat(MAX_MESSAGE_LENGTH + 1);
      expect(() => service.validate({ content: tooLong })).toThrow(/cannot exceed/i);
    });

    it('accepts content exactly at the length limit', () => {
      const atLimit = 'x'.repeat(MAX_MESSAGE_LENGTH);
      expect(service.validate({ content: atLimit }).content).toHaveLength(MAX_MESSAGE_LENGTH);
    });

    it('rejects a non-string sender', () => {
      expect(() => service.validate({ content: 'hi', sender: 42 })).toThrow(/sender must be/i);
    });
  });

  // ── Persistence ───────────────────────────────────────────────────────────

  describe('createMessage', () => {
    it('persists a valid message', async () => {
      const created = await service.createMessage({ content: 'hello', sender: 'ada' });

      expect(created.content).toBe('hello');
      expect(created.sender).toBe('ada');
      await expect(ChatMessage.countDocuments({})).resolves.toBe(1);
    });

    it('stores the trimmed content', async () => {
      const created = await service.createMessage({ content: '  padded  ' });
      expect(created.content).toBe('padded');
    });

    it('writes nothing when validation fails', async () => {
      await expect(service.createMessage({ content: '' })).rejects.toThrow(InvalidChatMessageError);
      await expect(ChatMessage.countDocuments({})).resolves.toBe(0);
    });
  });

  // ── Transcript ────────────────────────────────────────────────────────────

  describe('getRecentTranscript', () => {
    it('returns messages oldest first for display', async () => {
      await service.createMessage({ content: 'first' });
      await service.createMessage({ content: 'second' });
      await service.createMessage({ content: 'third' });

      const transcript = await service.getRecentTranscript();

      expect(transcript.map((message) => message.content)).toEqual(['first', 'second', 'third']);
    });

    it('returns the most recent messages when over the limit', async () => {
      for (let i = 0; i < RECENT_MESSAGE_LIMIT + 5; i += 1) {
        await service.createMessage({ content: `message-${i}` });
      }

      const transcript = await service.getRecentTranscript();

      expect(transcript).toHaveLength(RECENT_MESSAGE_LIMIT);
      // The oldest five are dropped, so the window starts at message-5.
      expect(transcript[0].content).toBe('message-5');
      expect(transcript[transcript.length - 1].content).toBe(`message-${RECENT_MESSAGE_LIMIT + 4}`);
    });

    it('honours an explicit limit', async () => {
      await service.createMessage({ content: 'a' });
      await service.createMessage({ content: 'b' });
      await service.createMessage({ content: 'c' });

      await expect(service.getRecentTranscript(2)).resolves.toHaveLength(2);
    });

    it('returns an empty transcript when there are no messages', async () => {
      await expect(service.getRecentTranscript()).resolves.toEqual([]);
    });
  });
});

describe('SocketService (transport adapter)', () => {
  let mongod: MongoMemoryServer;
  let adapter: SocketService;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    adapter = new SocketService();
  }, 60_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  }, 30_000);

  afterEach(async () => {
    await ChatMessage.deleteMany({});
  });

  it('replays the transcript to a connecting client', async () => {
    await new ChatMessageService().createMessage({ content: 'earlier' });

    const socket = createSocketDouble();
    await adapter.handleConnection(socket, createNamespaceDouble());

    expect(socket.emitted).toHaveLength(1);
    expect(socket.emitted[0].event).toBe('recentMessages');
    expect(socket.emitted[0].payload).toHaveLength(1);
  });

  it('broadcasts a valid message to the namespace', async () => {
    const nsp = createNamespaceDouble();
    const socket = createSocketDouble();

    await adapter.handleIncomingMessage(nsp, { content: 'hello' }, socket);

    expect(nsp.emitted).toHaveLength(1);
    expect(nsp.emitted[0].event).toBe('message');
    await expect(ChatMessage.countDocuments({})).resolves.toBe(1);
  });

  it('tells the sender why an invalid message was rejected', async () => {
    const nsp = createNamespaceDouble();
    const socket = createSocketDouble();

    await adapter.handleIncomingMessage(nsp, { content: '' }, socket);

    // Nothing is broadcast, and the sender learns the reason rather than
    // seeing its message vanish silently.
    expect(nsp.emitted).toHaveLength(0);
    expect(socket.emitted[0].event).toBe('error');
    expect(socket.emitted[0].payload).toMatchObject({ message: expect.stringMatching(/empty/i) });
    await expect(ChatMessage.countDocuments({})).resolves.toBe(0);
  });

  it('does not throw when no originating socket is supplied', async () => {
    const nsp = createNamespaceDouble();

    await expect(adapter.handleIncomingMessage(nsp, { content: '' })).resolves.toBeUndefined();
    expect(nsp.emitted).toHaveLength(0);
  });

  it('reports a transcript read failure to that client alone', async () => {
    const failing = new ChatMessageService({
      findRecent: jest.fn().mockRejectedValue(new Error('database unavailable')),
    } as never);
    const failingAdapter = new SocketService(failing);
    const socket = createSocketDouble();

    await failingAdapter.handleConnection(socket, createNamespaceDouble());

    expect(socket.emitted[0].event).toBe('error');
  });
});
