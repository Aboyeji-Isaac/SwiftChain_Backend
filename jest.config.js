const { createDefaultPreset } = require('ts-jest');
const tsJestTransformCfg = createDefaultPreset().transform;

/** @type {import("jest").Config} **/
module.exports = {
  testEnvironment: 'node',
  transform: {
    ...tsJestTransformCfg,
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        ...tsJestTransformCfg['^.+\\.tsx?$'][1],
        isolatedModules: true,
      },
    ],
  },
  setupFiles: ['<rootDir>/tests/jest.setup.ts'],
  // Allow enough time for MongoMemoryServer to start (and download the binary
  // on first run in a fresh environment).
  testTimeout: 30000,
  // Exclude the compiled output directory — tests should only run from source.
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],

  // Coverage configuration for test enforcement
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/index.ts',
    '!src/server.ts',
    '!src/seed.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'json-summary'],

  // Global coverage thresholds (80% bar across all code)
  // Services layer is held to 80% as core business logic
  // Controllers/Routes/Utils may have lower thresholds initially
  coverageThreshold: {
    global: {
      branches: 55,
      functions: 60,
      lines: 60,
      statements: 60,
    },
    // Services are the core business logic layer
    './src/services/': {
      branches: 55,
      functions: 70,
      lines: 70,
      statements: 70,
    },
    // Models represent data contracts — enforce 70% coverage
    './src/models/': {
      branches: 70,
      functions: 70,
      lines: 70,
      statements: 70,
    },
    // Routes handle HTTP contracts
    './src/routes/': {
      branches: 25,
      functions: 15,
      lines: 50,
      statements: 50,
    },
  },
};
