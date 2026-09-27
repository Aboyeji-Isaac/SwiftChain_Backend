/**
 * DriverLocation.ts
 *
 * Current, queryable position of each driver.
 *
 * This model is deliberately separate from `LocationUpdate`, which is an
 * append-only history of every ping a device sends. Proximity search reads the
 * *current* position of each driver, and answering that from the history
 * collection means finding the newest document per driver on every query —
 * a sort-and-group that no index makes fast.
 *
 * `DriverLocation` instead holds exactly one document per driver, upserted in
 * place as pings arrive, so a proximity search is a single index scan.
 *
 * ── Geospatial representation ────────────────────────────────────────────────
 * Coordinates are stored as a GeoJSON `Point`, which is what a `2dsphere`
 * index requires. Note the axis order: GeoJSON is `[longitude, latitude]`,
 * the reverse of the `{ lat, lng }` shape the API speaks. The helpers on this
 * model own that conversion so no caller has to remember it.
 *
 * ── Index strategy ───────────────────────────────────────────────────────────
 * Three indexes, each earning its place:
 *
 *  1. `{ driverId: 1 }` unique — enforces one document per driver and makes
 *     the upsert on every location ping a point lookup.
 *
 *  2. `{ location: '2dsphere' }` — the plain geospatial index. MongoDB can use
 *     a compound index prefixed by a geo field only for the geo predicate
 *     itself, so a standalone 2dsphere serves unfiltered radius searches.
 *
 *  3. `{ isAvailable: 1, status: 1, location: '2dsphere' }` — a compound
 *     index with the *equality* fields first and the geo field last. This is
 *     the ordering MongoDB's geo-near planner can exploit: it narrows to the
 *     available/online drivers and then walks the geometry, rather than
 *     scanning every driver in the radius and filtering afterwards. Nearly all
 *     production proximity queries are "find me an available driver near X",
 *     so this is the index that matters most.
 *
 * A TTL index on `expiresAt` retires drivers who stop reporting, so the
 * collection stays small and searches never return a driver who went offline
 * days ago.
 */

import { Schema, model, Document, Types, Model } from 'mongoose';
import env from '../config/env';

/** Availability state used to filter proximity searches. */
export type DriverAvailabilityStatus = 'online' | 'offline' | 'on_delivery';

/** GeoJSON Point as stored by MongoDB: `coordinates` is `[lng, lat]`. */
export interface IGeoPoint {
  type: 'Point';
  /** `[longitude, latitude]` — GeoJSON axis order, not `[lat, lng]`. */
  coordinates: [number, number];
}

/**
 * Mongoose document describing one driver's current position.
 */
export interface IDriverLocation extends Document {
  /** Reference to the driver (User._id). Unique across the collection. */
  driverId: Types.ObjectId;

  /** Current position as a GeoJSON Point. */
  location: IGeoPoint;

  /** Whether the driver is currently accepting assignments. */
  isAvailable: boolean;

  /** Coarse availability state, used alongside `isAvailable` for filtering. */
  status: DriverAvailabilityStatus;

  /** Reported heading in degrees clockwise from north, when the device supplies it. */
  heading?: number;

  /** Reported ground speed in metres per second, when the device supplies it. */
  speed?: number;

  /** Device-reported horizontal accuracy in metres. */
  accuracy?: number;

  /** Delivery this driver is currently assigned to, if any. */
  currentDeliveryId?: Types.ObjectId;

  /** When this position was recorded on the device. */
  recordedAt: Date;

  /**
   * Point at which this record is considered abandoned and is removed by the
   * TTL monitor. Refreshed on every update.
   */
  expiresAt: Date;

  createdAt: Date;
  updatedAt: Date;

  /** Convenience accessor returning the position in API `{ lat, lng }` form. */
  toLatLng(): { lat: number; lng: number };
}

/**
 * Static helpers attached to the model.
 */
export interface IDriverLocationModel extends Model<IDriverLocation> {
  /** Build a GeoJSON Point from API-order latitude/longitude. */
  toGeoPoint(lat: number, lng: number): IGeoPoint;
}

const GeoPointSchema = new Schema<IGeoPoint>(
  {
    type: {
      type: String,
      enum: ['Point'],
      required: true,
      default: 'Point',
    },
    coordinates: {
      type: [Number],
      required: true,
      validate: {
        validator: (value: number[]): boolean =>
          Array.isArray(value) &&
          value.length === 2 &&
          Number.isFinite(value[0]) &&
          Number.isFinite(value[1]) &&
          value[0] >= -180 &&
          value[0] <= 180 &&
          value[1] >= -90 &&
          value[1] <= 90,
        message:
          'coordinates must be [longitude, latitude] with longitude in [-180,180] and latitude in [-90,90]',
      },
    },
  },
  { _id: false },
);

const DriverLocationSchema = new Schema<IDriverLocation, IDriverLocationModel>(
  {
    driverId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'driverId is required'],
      unique: true,
    },

    location: {
      type: GeoPointSchema,
      required: [true, 'location is required'],
    },

    isAvailable: {
      type: Boolean,
      required: true,
      default: false,
    },

    status: {
      type: String,
      enum: ['online', 'offline', 'on_delivery'],
      required: true,
      default: 'offline',
    },

    heading: {
      type: Number,
      min: [0, 'heading must be between 0 and 360'],
      max: [360, 'heading must be between 0 and 360'],
    },

    speed: {
      type: Number,
      min: [0, 'speed cannot be negative'],
    },

    accuracy: {
      type: Number,
      min: [0, 'accuracy cannot be negative'],
    },

    currentDeliveryId: {
      type: Schema.Types.ObjectId,
      ref: 'Delivery',
      default: null,
    },

    recordedAt: {
      type: Date,
      required: true,
      default: (): Date => new Date(),
    },

    expiresAt: {
      type: Date,
      required: true,
    },
  },
  { timestamps: true },
);

// ─── Indexes ──────────────────────────────────────────────────────────────────

// Plain 2dsphere: serves radius searches that apply no availability filter.
DriverLocationSchema.index({ location: '2dsphere' }, { name: 'location_2dsphere' });

// The workhorse. Equality fields first, geometry last, so the planner can seek
// to the matching availability bucket before evaluating geometry.
DriverLocationSchema.index(
  { isAvailable: 1, status: 1, location: '2dsphere' },
  { name: 'availability_location_2dsphere' },
);

// Retire stale records. `expireAfterSeconds: 0` means "expire at the instant
// stored in expiresAt", which lets the staleness window be configured per
// write rather than baked into the index.
DriverLocationSchema.index(
  { expiresAt: 1 },
  { name: 'driver_location_ttl', expireAfterSeconds: 0 },
);

// ─── Hooks ────────────────────────────────────────────────────────────────────

/**
 * Keep `expiresAt` in step with `recordedAt` so every write extends the
 * record's life by exactly the configured staleness window.
 */
DriverLocationSchema.pre('validate', function (this: IDriverLocation) {
  const recordedAt = this.recordedAt ?? new Date();
  this.expiresAt = new Date(recordedAt.getTime() + env.DRIVER_LOCATION_STALE_AFTER_SECONDS * 1000);
});

// ─── Methods ──────────────────────────────────────────────────────────────────

DriverLocationSchema.methods.toLatLng = function (this: IDriverLocation): {
  lat: number;
  lng: number;
} {
  const [lng, lat] = this.location.coordinates;
  return { lat, lng };
};

DriverLocationSchema.statics.toGeoPoint = function (lat: number, lng: number): IGeoPoint {
  return { type: 'Point', coordinates: [lng, lat] };
};

export const DriverLocation = model<IDriverLocation, IDriverLocationModel>(
  'DriverLocation',
  DriverLocationSchema,
);

export default DriverLocation;
