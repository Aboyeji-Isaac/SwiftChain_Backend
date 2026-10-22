import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import PricingRule from '../src/models/PricingRule';
import DeliveryFeeQuote from '../src/models/DeliveryFeeQuote';
import { PricingService, PricingConditions } from '../src/services/pricingService';
import {
  DeliveryFeeQuoteRepository,
  PricingRuleRepository,
} from '../src/repositories/PricingRepository';
import { estimateFeeSchema } from '../src/validators/pricingValidator';

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await PricingRule.init();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

afterEach(async () => {
  await Promise.all([PricingRule.deleteMany({}), DeliveryFeeQuote.deleteMany({})]);
});

const conditions: PricingConditions = {
  route: async () => ({ distanceKm: 12, normalDurationMinutes: 20, trafficDurationMinutes: 35 }),
  rain: async () => 2,
};

const input = { pickup: { lat: 6.5, lng: 3.3 }, dropoff: { lat: 6.6, lng: 3.4 } };

it('calculates from the active database rule and returns the persisted quote', async () => {
  const rule = await PricingRule.create({
    name: 'test rule',
    active: true,
    assetCode: 'XLM',
    baseFee: 10,
    distanceRate: 2,
    trafficMinuteRate: 1,
    rainMillimeterRate: 3,
    minimumFee: 10,
    validityMinutes: 5,
  });
  const service = new PricingService(
    new PricingRuleRepository(),
    new DeliveryFeeQuoteRepository(),
    conditions,
  );
  const result = await service.estimate(input);
  expect(result.fee).toBe(55);
  expect(result.assetCode).toBe('XLM');
  const stored = await DeliveryFeeQuote.findById(result.quoteId);
  expect(stored?.pricingRule.toString()).toBe(String(rule._id));
  expect(stored?.fee).toBe(result.fee);
  expect(stored?.trafficDurationMinutes).toBe(35);
});

it('rejects estimates without configured database pricing', async () => {
  const service = new PricingService(
    new PricingRuleRepository(),
    new DeliveryFeeQuoteRepository(),
    conditions,
  );
  await expect(service.estimate(input)).rejects.toMatchObject({ statusCode: 503 });
});

it('rejects invalid coordinates at the request boundary', () => {
  expect(estimateFeeSchema.safeParse({ ...input, pickup: { lat: 200, lng: 3.3 } }).success).toBe(
    false,
  );
  expect(estimateFeeSchema.safeParse({ pickup: input.pickup, dropoff: input.pickup }).success).toBe(
    false,
  );
});
