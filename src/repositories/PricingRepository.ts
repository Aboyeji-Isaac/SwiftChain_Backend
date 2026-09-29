import { BaseRepository } from './BaseRepository';
import PricingRule, { IPricingRule } from '../models/PricingRule';
import DeliveryFeeQuote, { IDeliveryFeeQuote } from '../models/DeliveryFeeQuote';

export class PricingRuleRepository extends BaseRepository<IPricingRule> {
  constructor() {
    super(PricingRule);
  }

  findActive(): Promise<IPricingRule | null> {
    return this.findOne({ active: true });
  }
}

export class DeliveryFeeQuoteRepository extends BaseRepository<IDeliveryFeeQuote> {
  constructor() {
    super(DeliveryFeeQuote);
  }
}
