# Feature flag deployment guide

The feature flag registry is defined in src/config/flags.ts and validated environment variables are declared in src/config/env.ts.

## Known flags and defaults

| Flag | Default | Gated behavior |
| --- | --- | --- |
| webhookBatching | true | Retrying due webhook delivery attempts in batches |
| deliveryPooling | true | Creating delivery pools and assigning a pool to a driver |
| chat | true | Replaying chat history and persisting/broadcasting chat messages |
| milestones | false | Reserved for milestone behavior; no milestone service or entry point currently exists in this repository |

Defaults preserve the existing webhook retry, pooling, and chat behavior. The milestones flag remains off until a milestone implementation is introduced.

## Configure flags

FEATURE_FLAGS accepts comma-separated flag names or name=value pairs. A bare name enables that flag; a value must be true or false. Examples:

    FEATURE_FLAGS=chat=false,deliveryPooling=false

Individual variables override values supplied through FEATURE_FLAGS:

    FEATURE_WEBHOOK_BATCHING_ENABLED=false
    FEATURE_DELIVERY_POOLING_ENABLED=true
    FEATURE_CHAT_ENABLED=false
    FEATURE_MILESTONES_ENABLED=false

Leave individual variables unset or blank to use the registry default or the value supplied in FEATURE_FLAGS. Unknown names and invalid boolean values cause startup to fail with a clear configuration error rather than silently enabling or disabling behavior.

Flags are resolved at process startup. Updating environment configuration does not require a code change or new image, but the process must be restarted to load the new values.

## Operational behavior

- With webhookBatching disabled, the retry sweep returns zero processed attempts without querying due attempts. New webhook dispatch behavior is unchanged.
- With deliveryPooling disabled, pool creation returns an empty list and direct pool assignment returns an unassigned result. Ordinary one-to-one driver assignment is unchanged.
- With chat disabled, recent transcript reads return an empty list and incoming messages are not persisted or broadcast. Socket clients receive a clear disabled response when attempting to send a message.
- The milestones flag is registered and configurable, but cannot gate a milestone flow until that flow exists. Do not treat enabling the flag as enabling milestone functionality.

## Tests

Run the feature flag parsing and chat gate tests:

    pnpm test -- tests/featureFlags.test.ts tests/chatFeatureFlag.test.ts

Then run the full suite, type check/build, and lint before merging. Do not commit secrets or production credentials in this configuration.
