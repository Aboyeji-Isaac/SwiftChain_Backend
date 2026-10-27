/**
 * @deprecated **Do not use.** Issue #211 retired this legacy delivery model:
 * its lowercase status vocabulary (`pending/assigned/picked_up/in_transit/
 * delivered`) once collided with the canonical `Delivery` collection
 * (`src/models/Delivery.ts`) and corrupted the canonical state machine that
 * escrow release, driver assignment, and ETA rely on.
 *
 * The status-update endpoint now writes exclusively through the canonical
 * `DeliveryService.updateStatus` -> `DeliveryRepository.transitionStatus`
 * path. Existing documents carrying legacy statuses are migrated by
 * `src/scripts/migrateLegacyDeliveryStatuses.ts` (npm run migrate:delivery-statuses).
 *
 * Kept only until no remaining references exist; new code must import the
 * canonical model.
 */
import mongoose, { Document, Model, Schema } from 'mongoose';

/** @deprecated Use `DeliveryStatus` from `src/models/Delivery.ts` instead. */
export type DeliveryStatus = 'pending' | 'assigned' | 'picked_up' | 'in_transit' | 'delivered';

export interface DeliveryDocument extends Document {
  customerName: string;
  pickupLocation: string;
  dropoffLocation: string;
  packageDetails: string;
  status: DeliveryStatus;
  assignedDriver?: string;
  createdAt: Date;
  updatedAt: Date;
}

const deliverySchema = new Schema<DeliveryDocument>(
  {
    customerName: { type: String, required: true, trim: true },
    pickupLocation: { type: String, required: true, trim: true },
    dropoffLocation: { type: String, required: true, trim: true },
    packageDetails: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: ['pending', 'assigned', 'picked_up', 'in_transit', 'delivered'],
      default: 'pending',
      required: true,
    },
    assignedDriver: { type: String, default: null },
  },
  {
    timestamps: true,
  },
);

// ─── Indexes ────────────────────────────────────────────────────────────────
// Status is looked up and transitioned on every PUT /api/v1/deliveries/:id/status
// call (src/controllers/deliveryStatusController.ts); a single-field index
// supports filtering/listing deliveries by their current status.
deliverySchema.index({ status: 1 });

// Supports the natural "a driver's assigned deliveries" access pattern once a
// driver-facing listing endpoint queries this collection by assignedDriver.
deliverySchema.index({ assignedDriver: 1 });

/** @deprecated Use the canonical `Delivery` from `src/models/Delivery.ts`. */
export const Delivery =
  (mongoose.models.DeliveryLegacy as Model<DeliveryDocument>) ||
  mongoose.model<DeliveryDocument>('DeliveryLegacy', deliverySchema);
