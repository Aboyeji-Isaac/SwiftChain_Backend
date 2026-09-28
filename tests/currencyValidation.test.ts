import { createDeliverySchema } from '../src/validators/deliveryValidator';
import { fundEscrowBodySchema } from '../src/validators/escrowValidator';

const deliveryInput = {
  customer: { name: 'Customer', phone: '1234567890' },
  pickup: { address: 'Pickup' },
  dropoff: { address: 'Dropoff' },
  package: { description: 'Package' },
  escrowAmount: 2,
  deliveryFee: 1,
};

const fundInput = {
  deliveryId: '507f1f77bcf86cd799439011',
  contractId: 'CESCROW',
  transactionHash: 'tx-hash',
  amount: 2,
};

describe('currency API boundaries', () => {
  const previousIssuer = process.env.USDC_ASSET_ISSUER;
  beforeAll(() => {
    process.env.USDC_ASSET_ISSUER = 'GTESTISSUER';
  });
  afterAll(() => {
    if (previousIssuer === undefined) delete process.env.USDC_ASSET_ISSUER;
    else process.env.USDC_ASSET_ISSUER = previousIssuer;
  });

  it('validates delivery fee and escrow asset separately', () => {
    expect(
      createDeliverySchema.safeParse({
        ...deliveryInput,
        deliveryFeeAsset: { code: 'XLM' },
        escrowAsset: { code: 'USDC', issuer: 'GTESTISSUER' },
      }).success,
    ).toBe(true);
    expect(
      createDeliverySchema.safeParse({
        ...deliveryInput,
        escrowAsset: { code: 'USDC', issuer: 'GWRONG' },
      }).success,
    ).toBe(false);
  });

  it('rejects unsupported assets before recording a funded escrow', () => {
    expect(fundEscrowBodySchema.safeParse({ ...fundInput, asset: 'USDC' }).success).toBe(false);
    expect(
      fundEscrowBodySchema.safeParse({ ...fundInput, asset: 'USDC', assetIssuer: 'GTESTISSUER' })
        .success,
    ).toBe(true);
    expect(
      fundEscrowBodySchema.safeParse({ ...fundInput, asset: 'XLM', assetIssuer: 'GTESTISSUER' })
        .success,
    ).toBe(false);
  });
});
