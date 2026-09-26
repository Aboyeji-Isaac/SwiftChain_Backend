import { Socket } from 'socket.io';

/**
 * Metadata stored for each active socket connection.
 */
export interface SocketConnectionMeta {
  /** Unique socket identifier */
  socketId: string;
  /** Optional authenticated user ID */
  userId?: string;
  /** Timestamp when the connection was established (ms since epoch) */
  connectedAt: number;
  /** Timestamp of the last successful pong received (ms since epoch) */
  lastPongAt: number;
  /** Number of consecutive missed pongs */
  missedPongs: number;
  /** Rooms the socket is currently a member of */
  rooms: string[];
  /** Optional JWT expiration timestamp (ms since epoch) */
  tokenExp?: number;
}

/**
 * Payload emitted with the `ping` event.
 */
export interface PingPayload {
  timestamp: number;
}

/**
 * Payload emitted with the `pong` event.
 */
export interface PongPayload {
  timestamp: number;
  latency?: number;
}

/**
 * Payload emitted on `disconnect` events.
 */
export interface DisconnectPayload {
  socketId: string;
  userId?: string;
  reason: string;
  connectedDurationMs: number;
}

/**
 * Payload emitted on `auth_expired` when the server detects an expired
 * or invalid JWT during an active socket session.
 */
export interface AuthExpiredPayload {
  message: string;
  gracePeriodMs: number;
}

/**
 * Payload sent by the client on `auth_refresh` with a new JWT token.
 */
export interface RefreshTokenPayload {
  /** New JWT token. */
  token: string;
}

export interface AuthRefreshPayload {
  token: string;
}

/**
 * Acknowledgement emitted back on `auth_refresh_ack`.
 */
export interface AuthRefreshAckPayload {
  success: boolean;
  error?: string;
}

// ─── Offline sync types ───────────────────────────────────────────────────────

/**
 * A single buffered location point captured while the driver was offline.
 */
export interface OfflineLocationPoint {
  /** Client-side timestamp (ms since epoch) at which the fix was taken. */
  capturedAt: number;
  /** Latitude in decimal degrees. */
  lat: number;
  /** Longitude in decimal degrees. */
  lng: number;
  /** Optional delivery the driver was working on at capture time. */
  deliveryId?: string;
}

/**
 * Payload sent by a driver on the `location:sync` event upon reconnection.
 */
export interface LocationSyncPayload {
  /**
   * Ordered array of location points buffered offline.
   * The service will deduplicate and process them in chronological order.
   */
  updates: OfflineLocationPoint[];
}

/**
 * Per-item result within a sync acknowledgement.
 */
export interface SyncItemResult {
  capturedAt: number;
  status: 'saved' | 'duplicate' | 'invalid' | 'error';
  /** Populated when status === 'error' or 'invalid'. */
  reason?: string;
}

/**
 * Acknowledgement payload emitted back on `location:sync_ack`.
 */
export interface LocationSyncAck {
  /** ISO timestamp of when the server processed the batch. */
  processedAt: string;
  /** Total number of points received. */
  received: number;
  /** Number of points successfully persisted. */
  saved: number;
  /** Number of duplicate points skipped. */
  duplicates: number;
  /** Number of points that failed validation or persistence. */
  failed: number;
  /** Per-item results for full client-side reconciliation. */
  results: SyncItemResult[];
}

// ─── Real-time location broadcast types ──────────────────────────────────────

/**
 * Payload sent by a driver on the `driver_location_update` event.
 * Carries a live GPS fix tied to a specific delivery.
 */
export interface DriverLocationUpdatePayload {
  /** MongoDB ObjectId string of the delivery this update belongs to. */
  deliveryId: string;
  /** Latitude in decimal degrees (-90 to +90). */
  lat: number;
  /** Longitude in decimal degrees (-180 to +180). */
  lng: number;
  /**
   * Client-side timestamp (ms since epoch) at which the fix was captured.
   * Defaults to server receive time if omitted.
   */
  capturedAt?: number;
}

/**
 * Payload broadcast to all subscribers of a delivery room on
 * the `location:update` event.
 */
export interface LocationBroadcastPayload {
  /** MongoDB ObjectId string of the delivery being tracked. */
  deliveryId: string;
  /** Driver's MongoDB ObjectId string. */
  driverId: string;
  /** Latitude at time of fix. */
  lat: number;
  /** Longitude at time of fix. */
  lng: number;
  /** Client-side timestamp (ms since epoch). */
  capturedAt: number;
  /** ISO timestamp of when the server received and persisted the update. */
  receivedAt: string;
}

/**
 * Acknowledgement sent back to the driver after a live update is processed.
 */
export interface LocationUpdateAck {
  /** Whether the update was successfully persisted. */
  success: boolean;
  /** The persisted location record's MongoDB _id (for client reconciliation). */
  locationId?: string;
  /** Error message when success === false. */
  error?: string;
  /** True if the update was rejected as a duplicate. */
  isDuplicate?: boolean;
  /** True if the update was rejected as stale (older than last processed). */
  isStale?: boolean;
}

/**
 * Events that the server emits to clients.
 */
export interface ServerToClientEvents {
  ping: (payload: PingPayload) => void;
  disconnect_notice: (payload: DisconnectPayload) => void;
  location_sync_ack: (payload: LocationSyncAck) => void;
  /** Broadcast to all clients in a delivery room when the driver moves. */
  'location:update': (payload: LocationBroadcastPayload) => void;
  /** Ack sent back to the driver after a live location update is processed. */
  location_update_ack: (payload: LocationUpdateAck) => void;
  /** Notify client that authentication token has expired */
  auth_expired: (payload?: AuthExpiredPayload) => void;
  /** Acknowledge a client's token refresh attempt */
  auth_refresh_ack: (payload: AuthRefreshAckPayload) => void;
}

/**
 * Events that clients emit to the server.
 */
export interface ClientToServerEvents {
  pong: (payload: PongPayload) => void;
  join_room: (room: string) => void;
  leave_room: (room: string) => void;
  /** Fired by a client to acknowledge a queued server-side message. */
  message_ack: (messageId: string) => void;
  /** Fired by driver upon reconnection to flush offline-buffered updates. */
  location_sync: (payload: LocationSyncPayload) => void;
  /** Fired by driver to broadcast a live GPS fix to a delivery room. */
  driver_location_update: (payload: DriverLocationUpdatePayload) => void;
  /** Fired by client to submit a refreshed JWT without reconnecting. */
  auth_refresh: (payload: AuthRefreshPayload) => void;
  /** Legacy token-refresh event used by older clients. */
  refresh_token: (payload: RefreshTokenPayload) => void;
}

/**
 * Inter-server events (for multi-node setups).
 */
export interface InterServerEvents {
  ping: () => void;
}

/**
 * Per-socket data typed on the Socket instance.
 */
export interface SocketData {
  userId?: string;
  token?: string;
  connectedAt: number;
  /** JWT expiration timestamp in ms */
  tokenExp?: number;
}

/**
 * Typed Socket alias used across the sockets layer.
 */
export type TypedSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

/**
 * Result of a health-check sweep.
 */
export interface HealthCheckResult {
  checkedAt: string;
  totalConnections: number;
  staleConnectionsEvicted: number;
  activeConnections: number;
}
