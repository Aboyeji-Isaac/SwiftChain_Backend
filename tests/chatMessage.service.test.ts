/**
 * Unit tests for ChatMessageService.
 *
 * The chat logic does not need a running Socket.IO server to be tested:
 * ChatMessageService is exercised directly against a real in-process MongoDB.
 * (The socket transport adapter that used to be covered here was removed with
 * the dead dedicated socket server — see issue #212 — the service layer is
 * the durable part.)
 */

import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import ChatMessage from '../src/models/ChatMessage';
import {
  ChatMessageService,
  InvalidChatMessageError,
  MAX_MESSAGE_LENGTH,
  RECENT_MESSAGE_LIMIT,
} from '../src/sockets/chatMessage.service';

jest.mock('../src/config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

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
