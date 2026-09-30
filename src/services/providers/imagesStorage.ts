/**
 * Provider-agnostic images/file storage contract (issue #222).
 *
 * `storage.service.ts` already defines the `StorageDriver` abstraction with
 * local-disk and S3 implementations. This module gives that contract its
 * canonical, domain-facing name so consumers can depend on `IImagesStorage`
 * (consistent with `IPushProvider`/`IRoutingProvider`/`ISorobanRpcClient`)
 * and the driver can be registered in the DI container for test doubles.
 */

import type { StorageDriver } from '../storage.service';

/**
 * Contract for persisting uploaded images and retrieving their URLs.
 *
 * Functionally identical to `StorageDriver`; kept as a separate exported name
 * so the issue's `IImagesStorage` terminology has a canonical home and new
 * consumers can import the contract without reaching into driver internals.
 */
export type IImagesStorage = StorageDriver;
