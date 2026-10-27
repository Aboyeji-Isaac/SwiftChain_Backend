import {
  FEATURE_FLAG_DEFAULTS,
  parseFeatureFlags,
} from '../src/config/flags';

describe('feature flag configuration', () => {
  it('preserves existing optional behavior by default and leaves milestones disabled', () => {
    expect(FEATURE_FLAG_DEFAULTS).toEqual({
      webhookBatching: true,
      deliveryPooling: true,
      chat: true,
      milestones: false,
    });
  });

  it('parses bare names and explicit boolean values', () => {
    expect(parseFeatureFlags('chat=false, deliveryPooling=true')).toEqual({
      webhookBatching: true,
      deliveryPooling: true,
      chat: false,
      milestones: false,
    });
    expect(parseFeatureFlags('milestones')).toEqual({
      webhookBatching: true,
      deliveryPooling: true,
      chat: true,
      milestones: true,
    });
  });

  it('lets individual environment overrides take precedence over FEATURE_FLAGS', () => {
    expect(parseFeatureFlags('chat=false', { chat: true, deliveryPooling: false })).toEqual({
      webhookBatching: true,
      deliveryPooling: false,
      chat: true,
      milestones: false,
    });
  });

  it('rejects unknown flag names and invalid boolean values', () => {
    expect(() => parseFeatureFlags('unknownFeature=true')).toThrow('Unknown feature flag');
    expect(() => parseFeatureFlags('chat=maybe')).toThrow('Invalid boolean');
    expect(() => parseFeatureFlags('chat=true=false')).toThrow('Invalid FEATURE_FLAGS entry');
  });
});
