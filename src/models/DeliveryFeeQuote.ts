import mongoose, { Document, Model, Schema } from 'mongoose';

export interface IDeliveryFeeQuote extends Document {
  pricingRule: mongoose.Types.ObjectId;
  pickup: { lat: number; lng: number };
  dropoff: { lat: number; lng: number };
  distanceKm: number;
  normalDurationMinutes: number;
  trafficDurationMinutes: number;
  rainMillimeters: number;
  fee: number;
  assetCode: string;
  expiresAt: Date;
  createdAt: Date;
}

const coordinate = new Schema({ lat: Number, lng: Number }, { _id: false });
const DeliveryFeeQuoteSchema = new Schema<IDeliveryFeeQuote>(
  {
    pricingRule: { type: Schema.Types.ObjectId, ref: 'PricingRule', required: true },
    pickup: { type: coordinate, required: true },
    dropoff: { type: coordinate, required: true },
    distanceKm: { type: Number, required: true, min: 0 },
    normalDurationMinutes: { type: Number, required: true, min: 0 },
    trafficDurationMinutes: { type: Number, required: true, min: 0 },
    rainMillimeters: { type: Number, required: true, min: 0 },
    fee: { type: Number, required: true, min: 0 },
    assetCode: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

DeliveryFeeQuoteSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const DeliveryFeeQuote: Model<IDeliveryFeeQuote> =
  (mongoose.models.DeliveryFeeQuote as Model<IDeliveryFeeQuote>) ||
  mongoose.model<IDeliveryFeeQuote>('DeliveryFeeQuote', DeliveryFeeQuoteSchema);

export default DeliveryFeeQuote;
