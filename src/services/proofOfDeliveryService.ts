/**
 * proofOfDeliveryService.ts
 *
 * Enforces that a driver uploads photographic evidence before a delivery
 * can be marked completed or its escrow released.
 *
 * The image is written through the same storage driver abstraction used
 * for dispute evidence (`services/storage.service.ts`), which currently
 * backs onto local disk or S3; the driver interface is what a future IPFS
 * backend would implement, so this service does not hard-code S3.
 */

import { StatusCodes } from 'http-status-codes';
import { Types } from 'mongoose';
import Delivery, { IDelivery, DeliveryStatus, IProofOfDelivery } from '../models/Delivery';
import { getStorageDriver } from './storage.service';
import env from '../config/env';
import AppError from '../utils/AppError';
import logger from '../config/logger';

// ─── Constraints ───────────────────────────────────────────────────────────────

/** MIME types accepted for proof-of-delivery uploads. */
export const ALLOWED_PROOF_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

// ─── DTOs ──────────────────────────────────────────────────────────────────────

export interface UploadProofOfDeliveryInput {
  deliveryId: string;
  uploadedBy: string;
  originalName: string;
  mimeType: string;
  buffer: Buffer;
  sizeBytes: number;
}

// ─── Service ───────────────────────────────────────────────────────────────────

export class ProofOfDeliveryService {
  /**
   * Validate, persist, and attach a proof-of-delivery image to a delivery.
   *
   * Business rules enforced here:
   *  - `deliveryId` must reference an existing, non-terminal delivery.
   *  - Only the driver assigned to the delivery (or an admin) may upload.
   *  - MIME type must be an accepted image type.
   *  - File size must not exceed `PROOF_OF_DELIVERY_MAX_SIZE_MB`.
   *
   * @throws {AppError} 400 — invalid id or unsupported file.
   * @throws {AppError} 403 — the uploader is not the delivery's assigned driver.
   * @throws {AppError} 404 — delivery not found.
   * @throws {AppError} 409 — delivery is already completed or cancelled.
   * @throws {AppError} 413 — file exceeds the configured size limit.
   * @throws {AppError} 415 — unsupported MIME type.
   */
  async uploadProofOfDelivery(input: UploadProofOfDeliveryInput): Promise<IDelivery> {
    const { deliveryId, uploadedBy, originalName, mimeType, buffer, sizeBytes } = input;

    if (!Types.ObjectId.isValid(deliveryId)) {
      throw new AppError('Invalid delivery ID format.', StatusCodes.BAD_REQUEST);
    }

    const delivery = await Delivery.findById(deliveryId);
    if (!delivery) {
      throw new AppError('Delivery not found.', StatusCodes.NOT_FOUND);
    }

    if (
      delivery.status === DeliveryStatus.COMPLETED ||
      delivery.status === DeliveryStatus.CANCELLED
    ) {
      throw new AppError(
        `Cannot upload proof of delivery for a delivery with status '${delivery.status}'.`,
        StatusCodes.CONFLICT,
      );
    }

    if (delivery.driverId && delivery.driverId !== uploadedBy) {
      throw new AppError(
        'Only the driver assigned to this delivery may upload proof of delivery.',
        StatusCodes.FORBIDDEN,
      );
    }

    if (!ALLOWED_PROOF_MIME_TYPES.includes(mimeType as (typeof ALLOWED_PROOF_MIME_TYPES)[number])) {
      throw new AppError(
        `Unsupported file type "${mimeType}". Allowed types: ${ALLOWED_PROOF_MIME_TYPES.join(
          ', ',
        )}.`,
        StatusCodes.UNSUPPORTED_MEDIA_TYPE,
      );
    }

    const maxBytes = env.PROOF_OF_DELIVERY_MAX_SIZE_MB * 1024 * 1024;
    if (sizeBytes > maxBytes) {
      throw new AppError(
        `File exceeds the maximum allowed size of ${env.PROOF_OF_DELIVERY_MAX_SIZE_MB}MB.`,
        StatusCodes.REQUEST_TOO_LONG,
      );
    }

    const driver = getStorageDriver();
    const stored = await driver.upload(
      buffer,
      `proof-of-delivery/${deliveryId}/${originalName}`,
      mimeType,
    );

    const proofOfDelivery: IProofOfDelivery = {
      storageKey: stored.key,
      imageUrl: stored.url,
      storageDriver: env.UPLOAD_STORAGE_DRIVER,
      mimeType,
      sizeBytes,
      uploadedBy,
      uploadedAt: new Date(),
    };

    delivery.proofOfDelivery = proofOfDelivery;
    await delivery.save();

    logger.info(
      `[ProofOfDeliveryService] Uploaded — delivery=${deliveryId} uploadedBy=${uploadedBy} ` +
        `key=${stored.key} sizeBytes=${sizeBytes}`,
    );

    return delivery;
  }

  /**
   * Fetch the proof-of-delivery record for a delivery, if any.
   *
   * @throws {AppError} 400 — malformed delivery id.
   * @throws {AppError} 404 — delivery not found.
   */
  async getProofOfDelivery(deliveryId: string): Promise<IProofOfDelivery | null> {
    if (!Types.ObjectId.isValid(deliveryId)) {
      throw new AppError('Invalid delivery ID format.', StatusCodes.BAD_REQUEST);
    }

    const delivery = await Delivery.findById(deliveryId).select('proofOfDelivery');
    if (!delivery) {
      throw new AppError('Delivery not found.', StatusCodes.NOT_FOUND);
    }

    return delivery.proofOfDelivery ?? null;
  }

  /**
   * Guard used before a delivery is marked completed or its escrow is
   * released: throws unless proof of delivery is on record.
   *
   * @throws {AppError} 422 — no proof of delivery on record.
   */
  async assertProofOfDeliveryExists(deliveryId: string): Promise<void> {
    if (!Types.ObjectId.isValid(deliveryId)) {
      throw new AppError('Invalid delivery ID format.', StatusCodes.BAD_REQUEST);
    }

    const delivery = await Delivery.findById(deliveryId).select('proofOfDelivery');
    if (!delivery?.proofOfDelivery) {
      throw new AppError(
        'Proof of delivery is required before this delivery can be completed or its escrow released.',
        StatusCodes.UNPROCESSABLE_ENTITY,
      );
    }
  }
}

export const proofOfDeliveryService = new ProofOfDeliveryService();
export default proofOfDeliveryService;
