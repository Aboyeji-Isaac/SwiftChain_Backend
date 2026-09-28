import { z } from 'zod';
import { AppError } from '../utils/AppError';
import type { Asset } from '../types/asset';

export type { Asset } from '../types/asset';

/** Each balance belongs to one asset pool. No implicit exchange rate is applied. */
export const assetSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{1,12}$/),
  issuer: z.string().trim().optional(),
});

export function validateAsset(input: Asset): Asset {
  const parsed = assetSchema.safeParse(input);
  if (!parsed.success) throw new AppError('Invalid asset', 400);
  const { code, issuer } = parsed.data;
  if (code === 'XLM') {
    if (issuer) throw new AppError('XLM must not have an issuer', 400);
    return { code };
  }
  const supported = [
    { code: 'USDC', issuer: process.env.USDC_ASSET_ISSUER },
    { code: process.env.NATIVE_TOKEN_CODE?.toUpperCase(), issuer: process.env.NATIVE_TOKEN_ISSUER },
  ].find((asset) => asset.code === code && asset.issuer);
  if (!supported || !issuer || issuer !== supported.issuer) {
    throw new AppError(`Unsupported asset or issuer: ${code}`, 400);
  }
  return { code, issuer };
}

export function assertSameAsset(expected: Asset, actual: Asset): void {
  const left = validateAsset(expected);
  const right = validateAsset(actual);
  if (left.code !== right.code || left.issuer !== right.issuer) {
    throw new AppError('Escrow asset must match the delivery escrow asset', 409);
  }
}

/** The configured backend lock ABI takes no asset argument; reject other assets.
 * Verify this ABI against the deployed contract before using the lock endpoint. */
export function assertLockContractAsset(asset: Asset): void {
  if (validateAsset(asset).code !== 'XLM') {
    throw new AppError('Soroban escrow lock contract does not support this asset yet', 422);
  }
}
