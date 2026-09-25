process.env.NODE_ENV = 'test';
process.env.MONGOMS_DOWNLOAD_PROGRESS = '0';
// The env schema requires a >=16 char JWT secret and tests sign tokens with
// this exact value (CI sets the same via the JWT_SECRET env variable). dotenv
// does not override real environment variables, so this only applies when the
// runner does not provide one.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-key-16chars';
