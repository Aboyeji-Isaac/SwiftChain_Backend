import { IndexerService } from '../src/services/indexerService';

describe('IndexerService module wiring', () => {
  it('loads without relying on the removed webSocketService module', () => {
    const service = new IndexerService();

    expect(service).toBeInstanceOf(IndexerService);
    expect(typeof service.processDeliveryStatusUpdated).toBe('function');
  });
});
