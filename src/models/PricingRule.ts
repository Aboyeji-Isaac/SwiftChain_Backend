import mongoose, { Document, Model, Schema } from 'mongoose';

/** Rates are configured in MongoDB by operations, never supplied by the customer. */
export interface IPricingRule extends Document {
  name: string;
  active: boolean;
  assetCode: string;
  baseFee: number;
  distanceRate: number;
  trafficMinuteRate: number;
  rainMillimeterRate: number;
  minimumFee: number;
  validityMinutes: number;
  createdAt: Date;
  updatedAt: Date;
}

const nonnegative = { type: Number, required: true, min: 0 };
const PricingRuleSchema = new Schema<IPricingRule>(
  {
    name: { type: String, required: true, trim: true },
    active: { type: Boolean, required: true, default: false },
    assetCode: { type: String, required: true, trim: true, uppercase: true },
    baseFee: nonnegative,
    distanceRate: nonnegative,
    trafficMinuteRate: nonnegative,
    rainMillimeterRate: nonnegative,
    minimumFee: nonnegative,
    validityMinutes: { type: Number, required: true, min: 1, max: 1440 },
  },
  { timestamps: true },
);

PricingRuleSchema.index({ active: 1 }, { unique: true, partialFilterExpression: { active: true } });

const PricingRule: Model<IPricingRule> =
  (mongoose.models.PricingRule as Model<IPricingRule>) ||
  mongoose.model<IPricingRule>('PricingRule', PricingRuleSchema);

export default PricingRule;
