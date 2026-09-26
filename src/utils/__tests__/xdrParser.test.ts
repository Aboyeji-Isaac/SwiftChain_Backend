import { parseXdrEvent, parseXdrEventSafe, isValidXdr } from '../xdrParser';

describe('XDR Parser', () => {
  describe('parseXdrEvent', () => {
    it('should parse a valid delivery XDR payload', () => {
      const mockDeliveryXdr = createMockDeliveryXdr();
      const result = parseXdrEvent(mockDeliveryXdr);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('delivery');
      expect(result).toHaveProperty('deliveryId');
      expect(result).toHaveProperty('recipient');
      expect(result).toHaveProperty('amount');
      expect(result).toHaveProperty('asset');
    });

    it('should parse a valid escrow XDR payload', () => {
      const mockEscrowXdr = createMockEscrowXdr();
      const result = parseXdrEvent(mockEscrowXdr);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('escrow');
      expect(result).toHaveProperty('escrowId');
      expect(result).toHaveProperty('client');
      expect(result).toHaveProperty('freelancer');
      expect(result).toHaveProperty('amount');
      expect(result).toHaveProperty('asset');
    });

    it('should return null for malformed XDR', () => {
      const malformedXdr = 'this-is-not-valid-xdr';
      const result = parseXdrEvent(malformedXdr);
      expect(result).toBeNull();
    });

    it('should return null for empty XDR', () => {
      const result = parseXdrEvent('');
      expect(result).toBeNull();
    });

    it('should handle invalid base64 XDR gracefully', () => {
      const invalidXdr = '!!!invalid!!!';
      const result = parseXdrEvent(invalidXdr);
      expect(result).toBeNull();
    });
  });

  describe('parseXdrEventSafe', () => {
    it('should return null instead of throwing for invalid XDR', () => {
      const invalidXdr = 'invalid-xdr';
      const result = parseXdrEventSafe(invalidXdr);
      expect(result).toBeNull();
    });

    it('should parse valid XDR correctly', () => {
      const mockXdr = createMockDeliveryXdr();
      const result = parseXdrEventSafe(mockXdr);
      expect(result).not.toBeNull();
    });
  });

  describe('isValidXdr', () => {
    it('should return true for valid base64 XDR', () => {
      const validXdr = Buffer.from('valid-xdr-data').toString('base64');
      expect(isValidXdr(validXdr)).toBe(true);
    });

    it('should return false for invalid XDR', () => {
      // 🔥 FIX: These strings contain spaces or invalid characters
      expect(isValidXdr('not base64 with spaces')).toBe(false);
      expect(isValidXdr('')).toBe(false);
      expect(isValidXdr('  ')).toBe(false);
    });
  });

  describe('Integration: Multiple deliveries across different escrows', () => {
    it('should correctly parse multiple delivery events', () => {
      const mockDeliveries = [
        createMockDeliveryXdr('delivery1', 'recipient1', '100'),
        createMockDeliveryXdr('delivery2', 'recipient2', '200'),
        createMockDeliveryXdr('delivery3', 'recipient3', '300'),
      ];

      const results = mockDeliveries.map((xdr) => parseXdrEvent(xdr));

      expect(results).toHaveLength(3);
      results.forEach((result, index) => {
        expect(result?.type).toBe('delivery');
        expect(result?.amount).toBe(`${(index + 1) * 100}`);
      });
    });
  });

  // Mock XDR payload creators
  function createMockDeliveryXdr(
    deliveryId: string = 'del_123',
    recipient: string = 'GB123...',
    amount: string = '100',
  ): string {
    const mockData = {
      type: 'delivery',
      deliveryId,
      recipient,
      amount,
      asset: 'XLM',
      timestamp: Date.now(),
    };
    return Buffer.from(JSON.stringify(mockData)).toString('base64');
  }

  function createMockEscrowXdr(
    escrowId: string = 'esc_456',
    client: string = 'GC123...',
    freelancer: string = 'GB456...',
    amount: string = '500',
  ): string {
    const mockData = {
      type: 'escrow',
      escrowId,
      client,
      freelancer,
      amount,
      asset: 'XLM',
      releaseCondition: 'milestone_completed',
      timestamp: Date.now(),
    };
    return Buffer.from(JSON.stringify(mockData)).toString('base64');
  }
});
