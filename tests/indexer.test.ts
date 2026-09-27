import request from 'supertest';
import type { Express } from 'express';
import { Delivery } from '../src/models/Delivery';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

// Mock the real XDR decoding: the indexer posts base64 Soroban payloads and
// the handlers decode them with the Stellar SDK, which requires valid XDR.
// The SDK namespace is compiled and its members cannot be jest.spyOn'd, so
// the module is mocked here — before `../src/app` (and therefore the
// controller that requires the handlers) is imported below.
jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...actual,
    xdr: {
      ...actual.xdr,
      ScVal: {
        ...actual.xdr.ScVal,
        // The dummy payload below is not valid XDR; short-circuit decoding.
        fromXDR: jest.fn().mockReturnValue({} as never),
      },
    },
    scValToNative: jest.fn().mockImplementation(() => ({
      delivery_id: 'D-12345',
      contract_id: 'C-XYZ-789',
    })),
  };
});

// `app` is imported after the mock registration so the controller graph picks
// up the mocked SDK. Note: do NOT jest.resetModules() here — a fresh module
// registry would give the handlers a second mongoose connection that is not
// bound to the in-memory database.
const loadApp = async (): Promise<Express> => {
  const { default: app } = await import('../src/app');
  return app;
};

let mongoServer: MongoMemoryServer;
let app: Express;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();

  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }

  await mongoose.connect(mongoUri);
  app = await loadApp();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await Delivery.deleteMany({});
});

describe('Indexer API', () => {
  it('should update delivery correctly on delivery_created event', async () => {
    // Create a dummy delivery in DB
    await Delivery.create({
      deliveryId: 'D-12345',
      status: 'pending',
    });

    const response = await request(app)
      .post('/api/v1/indexer/delivery-created')
      .send({ payload: 'dummy-base64-payload' });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);

    // Verify DB update (DeliveryStatus enum values are lowercase)
    const updated = await Delivery.findOne({ deliveryId: 'D-12345' });
    expect(updated?.status).toBe('assigned');
    expect(updated?.contractId).toBe('C-XYZ-789');
  });
});
