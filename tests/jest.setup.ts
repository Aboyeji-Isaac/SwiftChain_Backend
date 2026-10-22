process.env.NODE_ENV = 'test';
process.env.MONGOMS_DOWNLOAD_PROGRESS = '0';
// Pin the MongoDB binary used by mongodb-memory-server. Without this, the
// default (6.0.x) is downloaded on first run. A value set in the environment
// still takes precedence so CI can override it.
process.env.MONGOMS_VERSION = process.env.MONGOMS_VERSION ?? '7.0.14';
// The env schema requires a >=16 char JWT secret and tests sign tokens with
// this exact value. dotenv does not override real environment variables, so
// this only applies when the runner does not provide a usable secret (a
// provided secret that is too short would make env.ts exit(1) at import time).
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 16) {
  process.env.JWT_SECRET = 'test-secret-key-16chars';
}
