/**
 * Concrete adapters implementing the provider contracts in this directory by
 * delegating to the real external SDKs (issue #222).
 *
 * Keeping the SDK wiring in one place means the rest of the codebase depends
 * only on the interfaces (`IRoutingProvider`, `ISorobanRpcClient`,
 * `IImagesStorage`), and unit tests can substitute fakes without network
 * access or module mocking.
 */

import axios from 'axios';
import type { Transaction, FeeBumpTransaction, rpc as StellarRpc } from '@stellar/stellar-sdk';
import { sorobanRpcClient } from '../../config/stellar';
import type { Coordinates, ETARequest, ETAResponse, IRoutingProvider } from './routingProvider';
import type {
  ISorobanRpcClient,
  PreparedTransaction,
  SorobanGetEventsRequest,
} from './sorobanRpcClient';

// ─── Google Maps routing adapter ──────────────────────────────────────────────

const GOOGLE_MAPS_DIRECTIONS_URL = 'https://maps.googleapis.com/maps/api/directions/json';

/** Median free-flow speed (km/h) used when no routing provider is configured. */
const FALLBACK_SPEEDS_KMH: Record<NonNullable<ETARequest['travelMode']>, number> = {
  driving: 40,
  walking: 5,
  bicycling: 15,
  transit: 25,
};

/**
 * Google Maps Directions implementation of {@link IRoutingProvider}.
 *
 * When no API key is configured (or the API call fails) it degrades to a
 * great-circle (Haversine) estimate so ETA endpoints keep working without
 * external credentials.
 */
export class GoogleMapsRoutingProvider implements IRoutingProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, baseUrl: string = GOOGLE_MAPS_DIRECTIONS_URL) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  async calculateETA(request: ETARequest): Promise<ETAResponse> {
    try {
      if (this.apiKey) {
        return await this.calculateWithGoogleMaps(request);
      }
      return this.calculateWithHaversine(request);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to calculate ETA:', error);
      throw new Error('Failed to calculate delivery ETA');
    }
  }

  private async calculateWithGoogleMaps(request: ETARequest): Promise<ETAResponse> {
    const { pickup, dropoff, travelMode = 'driving' } = request;

    const params = {
      origin: `${pickup.lat},${pickup.lng}`,
      destination: `${dropoff.lat},${dropoff.lng}`,
      mode: travelMode,
      key: this.apiKey,
      units: 'metric',
    };

    const response = await axios.get(this.baseUrl, { params });

    if (response.data.status !== 'OK') {
      throw new Error(`Google Maps API error: ${response.data.status}`);
    }

    const route = response.data.routes[0];
    const leg = route.legs[0];

    return {
      estimatedTime: Math.ceil(leg.duration.value / 60),
      distance: leg.distance.value / 1000,
      durationText: leg.duration.text,
      distanceText: leg.distance.text,
      route: {
        distance: leg.distance.value,
        duration: leg.duration.value,
        distanceText: leg.distance.text,
        durationText: leg.duration.text,
      },
    };
  }

  private calculateWithHaversine(request: ETARequest): ETAResponse {
    const { pickup, dropoff, travelMode = 'driving' } = request;

    const distance = this.calculateHaversineDistance(pickup, dropoff);
    const distanceKm = distance / 1000;

    const speed = FALLBACK_SPEEDS_KMH[travelMode];
    const durationMinutes = (distanceKm / speed) * 60;

    return {
      estimatedTime: Math.ceil(durationMinutes),
      distance: Math.round(distanceKm * 100) / 100,
      durationText: `${Math.ceil(durationMinutes)} mins`,
      distanceText: `${Math.round(distanceKm * 100) / 100} km`,
      route: {
        distance,
        duration: durationMinutes * 60,
        distanceText: `${Math.round(distanceKm * 100) / 100} km`,
        durationText: `${Math.ceil(durationMinutes)} mins`,
      },
    };
  }

  /**
   * Calculate the great-circle distance between two points using the Haversine
   * formula. Handles edge cases including anti-meridian crossings (±180°
   * longitude).
   *
   * @param point1 - First coordinate point
   * @param point2 - Second coordinate point
   * @returns Distance in meters
   */
  private calculateHaversineDistance(point1: Coordinates, point2: Coordinates): number {
    const R = 6371000; // Earth's radius in meters

    const lat1Rad = this.toRadians(point1.lat);
    const lat2Rad = this.toRadians(point2.lat);
    const dLatRad = this.toRadians(point2.lat - point1.lat);

    // Handle anti-meridian edge case:
    // When longitude difference exceeds 180°, wrap around the shorter path
    let lngDiff = point2.lng - point1.lng;

    // Normalize longitude difference to [-180, 180]
    if (lngDiff > 180) {
      lngDiff -= 360;
    } else if (lngDiff < -180) {
      lngDiff += 360;
    }

    const dLngRad = this.toRadians(lngDiff);

    // Haversine formula
    const a =
      Math.sin(dLatRad / 2) * Math.sin(dLatRad / 2) +
      Math.cos(lat1Rad) * Math.cos(lat2Rad) * Math.sin(dLngRad / 2) * Math.sin(dLngRad / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  private toRadians(degrees: number): number {
    return degrees * (Math.PI / 180);
  }
}

// ─── Soroban RPC adapter ──────────────────────────────────────────────────────

/**
 * `@stellar/stellar-sdk` implementation of {@link ISorobanRpcClient}.
 *
 * A thin delegate over `rpc.Server`: every method maps 1:1 onto the SDK, so
 * there is no behaviour to test here — the value is that consumers can accept
 * the interface and tests can pass fakes instead.
 */
export class SdkSorobanRpcClient implements ISorobanRpcClient {
  private readonly server: StellarRpc.Server;

  constructor(server: StellarRpc.Server = sorobanRpcClient) {
    this.server = server;
  }

  getAccount(address: string) {
    return this.server.getAccount(address);
  }

  getHealth() {
    return this.server.getHealth();
  }

  getTransaction(hash: string) {
    return this.server.getTransaction(hash);
  }

  getEvents(request: SorobanGetEventsRequest) {
    return this.server.getEvents(request);
  }

  getLatestLedger() {
    return this.server.getLatestLedger();
  }

  getNetwork() {
    return this.server.getNetwork();
  }

  prepareTransaction(tx: Transaction | FeeBumpTransaction): Promise<PreparedTransaction> {
    return this.server.prepareTransaction(tx);
  }

  sendTransaction(tx: Transaction | FeeBumpTransaction) {
    return this.server.sendTransaction(tx);
  }
}

/** Shared adapter instance wrapping the configured default `rpc.Server`. */
export const defaultSorobanRpcClient: ISorobanRpcClient = new SdkSorobanRpcClient();
