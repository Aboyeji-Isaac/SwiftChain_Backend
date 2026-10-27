import env from './env';

export const FEATURE_FLAG_DEFAULTS = {
  webhookBatching: true,
  deliveryPooling: true,
  chat: true,
  milestones: false,
} as const;

export type FeatureFlag = keyof typeof FEATURE_FLAG_DEFAULTS;
export type FeatureFlagValues = Record<FeatureFlag, boolean>;
export type FeatureFlagOverrides = Partial<Record<FeatureFlag, boolean>>;

/**
 * Parse a comma-separated list of feature names or name=value pairs.
 * A bare name enables that flag; an explicit value must be true or false.
 * Unknown names and malformed values fail fast during application startup.
 */
export const parseFeatureFlags = (
  input: string,
  overrides: FeatureFlagOverrides = {},
): FeatureFlagValues => {
  const flags: FeatureFlagValues = { ...FEATURE_FLAG_DEFAULTS };

  if (input.trim()) {
    for (const entry of input.split(',')) {
      const token = entry.trim();
      if (!token) continue;

      const parts = token.split('=');
      if (parts.length > 2) {
        throw new Error('Invalid FEATURE_FLAGS entry: ' + token);
      }

      const name = parts[0].trim();
      if (!Object.prototype.hasOwnProperty.call(FEATURE_FLAG_DEFAULTS, name)) {
        throw new Error('Unknown feature flag: ' + name);
      }

      let enabled = true;
      if (parts.length === 2) {
        const value = parts[1].trim().toLowerCase();
        if (value !== 'true' && value !== 'false') {
          throw new Error('Invalid boolean for feature flag ' + name + ': ' + parts[1]);
        }
        enabled = value === 'true';
      }

      flags[name as FeatureFlag] = enabled;
    }
  }

  for (const [name, value] of Object.entries(overrides) as Array<[FeatureFlag, boolean | undefined]>) {
    if (value !== undefined) {
      flags[name] = value;
    }
  }

  return flags;
};

const featureFlags = parseFeatureFlags(env.FEATURE_FLAGS, {
  webhookBatching: env.FEATURE_WEBHOOK_BATCHING_ENABLED,
  deliveryPooling: env.FEATURE_DELIVERY_POOLING_ENABLED,
  chat: env.FEATURE_CHAT_ENABLED,
  milestones: env.FEATURE_MILESTONES_ENABLED,
});

/** Return whether a known optional feature is enabled in this process. */
export const isEnabled = (flag: FeatureFlag): boolean => featureFlags[flag];

/** Return a defensive copy of the resolved feature-flag registry. */
export const getFeatureFlags = (): FeatureFlagValues => ({ ...featureFlags });
