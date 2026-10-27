/**
 * Provider-agnostic routing/directions contract.
 *
 * ETA-dependent services (delivery ETA, delivery pooling) depend only on this
 * interface, so swapping Google Maps Directions for another routing provider
 * (Mapbox, OSRM, …) is a configuration change rather than a rewrite of the
 * business logic. It also lets unit tests inject deterministic fakes instead
 * of calling the Google Maps API.
 */

/** A geographic point in decimal degrees. */
export interface Coordinates {
  lat: number;
  lng: number;
}

/** Raw route metrics returned by the underlying directions provider. */
export interface RouteInfo {
  distance: number;
  duration: number;
  distanceText: string;
  durationText: string;
}

/** Input for an ETA calculation. */
export interface ETARequest {
  pickup: Coordinates;
  dropoff: Coordinates;
  travelMode?: 'driving' | 'walking' | 'bicycling' | 'transit';
}

/** Result of an ETA calculation. */
export interface ETAResponse {
  estimatedTime: number;
  distance: number;
  durationText: string;
  distanceText: string;
  route: RouteInfo;
}

/**
 * Contract for a directions/ETA provider.
 *
 * Implementations must degrade gracefully (e.g. a distance-based fallback)
 * when the provider is not configured, and throw when the request cannot be
 * served at all.
 */
export interface IRoutingProvider {
  calculateETA(request: ETARequest): Promise<ETAResponse>;
}
