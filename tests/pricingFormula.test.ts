import { calculateFee } from '../src/services/pricingService';
import { estimateFeeSchema } from '../src/validators/pricingValidator';

const rates = {
  baseFee: 10,
  distanceRate: 2,
  trafficMinuteRate: 1,
  rainMillimeterRate: 3,
  minimumFee: 20,
};

it('charges distance, traffic delay and precipitation at the configured rates', () => {
  expect(calculateFee(rates, 12, 20, 35, 2)).toBe(55);
  expect(calculateFee(rates, 0, 20, 10, 0)).toBe(20);
});

it('rejects invalid and identical coordinates', () => {
  const pickup = { lat: 6.5, lng: 3.3 };
  expect(estimateFeeSchema.safeParse({ pickup, dropoff: { lat: 200, lng: 3.4 } }).success).toBe(
    false,
  );
  expect(estimateFeeSchema.safeParse({ pickup, dropoff: pickup }).success).toBe(false);
});
