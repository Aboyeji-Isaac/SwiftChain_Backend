import axios from 'axios';
import { z } from 'zod';
import { StatusCodes } from 'http-status-codes';
import env from '../config/env';
import AppError from '../utils/AppError';
import type { IPricingRule } from '../models/PricingRule';
import {
  DeliveryFeeQuoteRepository,
  PricingRuleRepository,
} from '../repositories/PricingRepository';

export interface Point {
  lat: number;
  lng: number;
}

export interface FeeEstimateInput {
  pickup: Point;
  dropoff: Point;
}

export interface FeeEstimate {
  quoteId: string;
  fee: number;
  assetCode: string;
  expiresAt: Date;
  distanceKm: number;
  normalDurationMinutes: number;
  trafficDurationMinutes: number;
  rainMillimeters: number;
}

const directionsResponse = z.object({
  status: z.string(),
  routes: z.array(
    z.object({
      legs: z.array(
        z.object({
          distance: z.object({ value: z.number().nonnegative() }),
          duration: z.object({ value: z.number().nonnegative() }),
          duration_in_traffic: z.object({ value: z.number().nonnegative() }),
        }),
      ),
    }),
  ),
});

const weatherResponse = z.object({
  cod: z.union([z.number(), z.string()]),
  rain: z.object({ '1h': z.number().nonnegative().optional() }).optional(),
  snow: z.object({ '1h': z.number().nonnegative().optional() }).optional(),
});

/** Network adapters are injected so tests can exercise pricing without calling providers. */
export interface PricingConditions {
  route(
    pickup: Point,
    dropoff: Point,
  ): Promise<{
    distanceKm: number;
    normalDurationMinutes: number;
    trafficDurationMinutes: number;
  }>;
  rain(dropoff: Point): Promise<number>;
}

/** Rates come from the active MongoDB rule. */
export function calculateFee(
  rule: Pick<
    IPricingRule,
    'baseFee' | 'distanceRate' | 'trafficMinuteRate' | 'rainMillimeterRate' | 'minimumFee'
  >,
  distanceKm: number,
  normalDurationMinutes: number,
  trafficDurationMinutes: number,
  rainMillimeters: number,
): number {
  const trafficDelay = Math.max(0, trafficDurationMinutes - normalDurationMinutes);
  const calculated =
    rule.baseFee +
    distanceKm * rule.distanceRate +
    trafficDelay * rule.trafficMinuteRate +
    rainMillimeters * rule.rainMillimeterRate;
  return Math.round(Math.max(rule.minimumFee, calculated) * 100) / 100;
}

export class LivePricingConditions implements PricingConditions {
  async route(
    pickup: Point,
    dropoff: Point,
  ): Promise<{
    distanceKm: number;
    normalDurationMinutes: number;
    trafficDurationMinutes: number;
  }> {
    if (!env.GOOGLE_MAPS_API_KEY) {
      throw new AppError('Live routing is not configured.', StatusCodes.SERVICE_UNAVAILABLE);
    }
    try {
      const response = await axios.get<unknown>(
        'https://maps.googleapis.com/maps/api/directions/json',
        {
          params: {
            origin: `${pickup.lat},${pickup.lng}`,
            destination: `${dropoff.lat},${dropoff.lng}`,
            mode: 'driving',
            departure_time: 'now',
            key: env.GOOGLE_MAPS_API_KEY,
          },
          timeout: 8000,
        },
      );
      const parsed = directionsResponse.parse(response.data);
      const leg = parsed.routes[0]?.legs[0];
      if (parsed.status !== 'OK' || !leg) throw new Error(`Directions status: ${parsed.status}`);
      return {
        distanceKm: leg.distance.value / 1000,
        normalDurationMinutes: leg.duration.value / 60,
        trafficDurationMinutes: leg.duration_in_traffic.value / 60,
      };
    } catch {
      throw new AppError('Live route and traffic data are unavailable.', StatusCodes.BAD_GATEWAY);
    }
  }

  async rain(dropoff: Point): Promise<number> {
    if (!env.OPENWEATHER_API_KEY) {
      throw new AppError('Live weather is not configured.', StatusCodes.SERVICE_UNAVAILABLE);
    }
    try {
      const response = await axios.get<unknown>('https://api.openweathermap.org/data/2.5/weather', {
        params: { lat: dropoff.lat, lon: dropoff.lng, appid: env.OPENWEATHER_API_KEY },
        timeout: 8000,
      });
      const parsed = weatherResponse.parse(response.data);
      if (Number(parsed.cod) !== 200) throw new Error('Weather request failed');
      return (parsed.rain?.['1h'] ?? 0) + (parsed.snow?.['1h'] ?? 0);
    } catch {
      throw new AppError('Live weather data are unavailable.', StatusCodes.BAD_GATEWAY);
    }
  }
}

export class PricingService {
  constructor(
    private readonly rules: PricingRuleRepository = new PricingRuleRepository(),
    private readonly quotes: DeliveryFeeQuoteRepository = new DeliveryFeeQuoteRepository(),
    private readonly conditions: PricingConditions = new LivePricingConditions(),
  ) {}

  async estimate(input: FeeEstimateInput): Promise<FeeEstimate> {
    const rule = await this.rules.findActive();
    if (!rule)
      throw new AppError(
        'No active delivery pricing rule is configured.',
        StatusCodes.SERVICE_UNAVAILABLE,
      );
    const [route, rainMillimeters] = await Promise.all([
      this.conditions.route(input.pickup, input.dropoff),
      this.conditions.rain(input.dropoff),
    ]);
    const { distanceKm, normalDurationMinutes, trafficDurationMinutes } = route;
    if (
      ![distanceKm, normalDurationMinutes, trafficDurationMinutes, rainMillimeters].every(
        (value) => Number.isFinite(value) && value >= 0,
      )
    )
      throw new AppError('Live pricing conditions are invalid.', StatusCodes.BAD_GATEWAY);

    const fee = calculateFee(
      rule,
      distanceKm,
      normalDurationMinutes,
      trafficDurationMinutes,
      rainMillimeters,
    );
    if (!Number.isFinite(fee))
      throw new AppError('Pricing rule produced an invalid fee.', StatusCodes.SERVICE_UNAVAILABLE);

    const saved = await this.quotes.create({
      pricingRule: rule._id,
      pickup: input.pickup,
      dropoff: input.dropoff,
      distanceKm,
      normalDurationMinutes,
      trafficDurationMinutes,
      rainMillimeters,
      fee,
      assetCode: rule.assetCode,
      expiresAt: new Date(Date.now() + rule.validityMinutes * 60_000),
    });
    const quote = await this.quotes.findById(String(saved._id));
    if (!quote)
      throw new AppError(
        'The fee estimate could not be retrieved.',
        StatusCodes.INTERNAL_SERVER_ERROR,
      );
    return {
      quoteId: String(quote._id),
      fee: quote.fee,
      assetCode: quote.assetCode,
      expiresAt: quote.expiresAt,
      distanceKm: quote.distanceKm,
      normalDurationMinutes: quote.normalDurationMinutes,
      trafficDurationMinutes: quote.trafficDurationMinutes,
      rainMillimeters: quote.rainMillimeters,
    };
  }
}

export const pricingService = new PricingService();
