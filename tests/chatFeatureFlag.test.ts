jest.mock('../src/config/flags', () => ({
  isEnabled: (flag: string) => flag !== 'chat',
}));

import {
  ChatFeatureDisabledError,
  ChatMessageService,
} from '../src/sockets/chatMessage.service';
import type { ChatMessageRepository } from '../src/repositories/ChatMessageRepository';

describe('chat feature flag', () => {
  const repository = {
    findRecent: jest.fn(),
    create: jest.fn(),
  };

  const service = new ChatMessageService(repository as unknown as ChatMessageRepository);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does not read chat history while chat is disabled', async () => {
    await expect(service.getRecentTranscript()).resolves.toEqual([]);
    expect(repository.findRecent).not.toHaveBeenCalled();
  });

  it('rejects message persistence while chat is disabled', async () => {
    await expect(service.createMessage({ content: 'hello' })).rejects.toBeInstanceOf(
      ChatFeatureDisabledError,
    );
    expect(repository.create).not.toHaveBeenCalled();
  });
});
