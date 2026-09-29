import {
  assertLockContractAsset,
  assertSameAsset,
  validateAsset,
} from '../src/services/currencyService';

describe('asset pools', () => {
  const previous = process.env.USDC_ASSET_ISSUER;
  beforeEach(() => {
    process.env.USDC_ASSET_ISSUER = 'GTESTISSUER';
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.USDC_ASSET_ISSUER;
    else process.env.USDC_ASSET_ISSUER = previous;
  });

  it('normalizes native XLM and rejects an issuer for it', () => {
    expect(validateAsset({ code: 'xlm' })).toEqual({ code: 'XLM' });
    expect(() => validateAsset({ code: 'XLM', issuer: 'GTESTISSUER' })).toThrow();
  });
  it('requires configured issuers and never combines distinct asset pools', () => {
    expect(validateAsset({ code: 'usdc', issuer: 'GTESTISSUER' })).toEqual({
      code: 'USDC',
      issuer: 'GTESTISSUER',
    });
    expect(() => validateAsset({ code: 'USDC', issuer: 'GOTHER' })).toThrow();
    expect(() =>
      assertSameAsset({ code: 'XLM' }, { code: 'USDC', issuer: 'GTESTISSUER' }),
    ).toThrow();
    expect(() => assertLockContractAsset({ code: 'USDC', issuer: 'GTESTISSUER' })).toThrow();
  });
});
