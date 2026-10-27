jest.mock('../src/config/flags', () => ({
  isEnabled: (flag: string) => flag !== 'deliveryPooling' && flag !== 'webhookBatching',
}));

jest.mock('../src/models/WebhookDeliveryAttempt', () => ({
  WebhookDeliveryAttempt: {
    find: jest.fn(),
  },
}));

import poolingService, { DeliveryPool } from '../src/services/poolingService';
import webhookService from '../src/services/webhookService';
import { WebhookDeliveryAttempt } from '../src/models/WebhookDeliveryAttempt';

describe('feature-flag service gates', () => {
  it('does not query or create delivery pools when pooling is disabled', async () => {
    await expect(poolingService.createPools()).resolves.toEqual([]);
    await expect(
      poolingService.assignPoolToNearestDriver({} as DeliveryPool),
    ).resolves.toEqual({
      assigned: false,
      reason: 'Delivery pooling is disabled by feature flag',
    });
  });

  it('does not query due webhook attempts when webhook batching is disabled', async () => {
    await expect(webhookService.retryDueAttempts()).resolves.toBe(0);
    expect(WebhookDeliveryAttempt.find).not.toHaveBeenCalled();
  });
});
