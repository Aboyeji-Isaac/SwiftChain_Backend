/**
 * Routing facade over the injectable {@link IRoutingProvider} (issue #222).
 *
 * The Google Maps implementation (plus the Haversine fallback) now lives in
 * `providers/adapters.ts` behind the `IRoutingProvider` contract, so ETA
 * consumers and unit tests can swap in a fake without touching this module.
 * The exported types are re-exports of the shared contract to keep existing
 * imports (`import { ETARequest } from './routingService'`) working.
 */

import env from '../config/env';
import { GoogleMapsRoutingProvider } from './providers/adapters';
import type {
  Coordinates,
  ETARequest,
  ETAResponse,
  IRoutingProvider,
} from './providers/routingProvider';

export type { Coordinates, ETARequest, ETAResponse };
export { IRoutingProvider };

class RoutingService implements IRoutingProvider {
  private readonly provider: IRoutingProvider;

  constructor(
    provider: IRoutingProvider = new GoogleMapsRoutingProvider(env.GOOGLE_MAPS_API_KEY ?? ''),
  ) {
    this.provider = provider;
  }

  async calculateETA(request: ETARequest): Promise<ETAResponse> {
    return this.provider.calculateETA(request);
  }
}

export const routingService = new RoutingService();
