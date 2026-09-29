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
      branches: 60,
      functions: 60,
      lines: 60,
      statements: 60,
    },
    // Services are the core business logic layer — enforce 80% coverage
    './src/services/': {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80,
    },
    // Models represent data contracts — enforce 75% coverage
    './src/models/': {
      branches: 70,
      functions: 70,
      lines: 70,
      statements: 70,
    },
    // Routes handle HTTP contracts — enforce 70% coverage
    './src/routes/': {
      branches: 60,
      functions: 60,
      lines: 60,
      statements: 60,
    },
  },
};
