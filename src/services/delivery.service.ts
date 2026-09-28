import { Types } from 'mongoose';
import { Asset, validateAsset } from './currencyService';
import httpStatus from 'http-status-codes';
import Delivery, { IDelivery, DeliveryStatus, ILocation, IPackage } from '../models/Delivery';
import Escrow, { EscrowStatus } from '../models/Escrow';
import { AppError } from '../utils/AppError';
import logger from '../config/logger';
import { deliveryRepository } from '../repositories/DeliveryRepository';
import { notificationService } from './notificationService';
import { webhookService } from './webhookService';
import { proofOfDeliveryService } from './proofOfDeliveryService';

export interface CreateDeliveryInput {
  trackingNumber: string;
  customer: {
    name: string;
    phone: string;
    email?: string;
  };
  pickup: ILocation;
  dropoff: ILocation;
  package: IPackage;
  deliveryFee: number;
  deliveryFeeAsset?: Asset;
  escrowAmount: number;
  escrowAsset?: Asset;
  notes?: string;
}

export interface UpdateDeliveryInput {
  status?: DeliveryStatus;
  driver?: string;
  estimatedDistance?: number;
  estimatedDuration?: number;
  stellarTransactionId?: string;
  notes?: string;
}

export interface AssignDriverInput {
  /** MongoDB `_id` of the delivery to assign a driver to. */
  deliveryId: string;
  /** The driver identifier to assign. */
  driverId: string;
}

export interface DeliveryFilter {
  status?: DeliveryStatus;
  driver?: string;
  search?: string;
  page?: number;
  limit?: number;
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * Legal delivery status transitions.
 *
 * Encoded as a map rather than checked inline so the state machine is
 * inspectable in one place and covered directly by tests. Terminal states map
 * to an empty list: nothing follows a completed or cancelled delivery.
 */
const ALLOWED_TRANSITIONS: Record<DeliveryStatus, readonly DeliveryStatus[]> = {
  [DeliveryStatus.PENDING]: [
    DeliveryStatus.FUNDED,
    DeliveryStatus.ASSIGNED,
    DeliveryStatus.CANCELLED,
  ],
  [DeliveryStatus.FUNDED]: [DeliveryStatus.ASSIGNED, DeliveryStatus.CANCELLED],
  [DeliveryStatus.ASSIGNED]: [DeliveryStatus.IN_PROGRESS, DeliveryStatus.CANCELLED],
  [DeliveryStatus.IN_PROGRESS]: [DeliveryStatus.COMPLETED, DeliveryStatus.CANCELLED],
  [DeliveryStatus.COMPLETED]: [],
  [DeliveryStatus.CANCELLED]: [],
};

export class DeliveryService {
  /**
   * Generates a QR code for secure delivery handoff verification (merged
   * capability from the legacy deliveryService module).
   */
  generateHandoffQrCode!: (deliveryId: string) => Promise<HandoffQrCodeResult>;
  async create(input: CreateDeliveryInput): Promise<IDelivery> {
    const existing = await Delivery.findOne({
      trackingNumber: input.trackingNumber,
    }).setOptions({ includeDeleted: true });

    if (existing) {
      throw new AppError('Delivery with this tracking number already exists', httpStatus.CONFLICT);
    }

    const delivery = await Delivery.create({
      ...input,
      deliveryFeeAsset: validateAsset(input.deliveryFeeAsset ?? { code: 'XLM' }),
      escrowAsset: validateAsset(input.escrowAsset ?? { code: 'XLM' }),
    });
    logger.info(`Delivery created: ${delivery.trackingNumber}`);
    return delivery;
  }

  async getById(id: string): Promise<IDelivery> {
    if (!Types.ObjectId.isValid(id)) {
      throw new AppError('Invalid delivery ID', httpStatus.BAD_REQUEST);
    }

    const delivery = await Delivery.findOne({ _id: id, isDeleted: { $ne: true } });
    if (!delivery) {
      throw new AppError('Delivery not found', httpStatus.NOT_FOUND);
    }
    return delivery;
  }

  async list(filters: DeliveryFilter): Promise<PaginatedResult<IDelivery>> {
    const { status, driver, search, page = 1, limit = 10 } = filters;

    const query: Record<string, unknown> = {
      // Soft-deleted deliveries are only exposed via GET /deliveries/archived.
      isDeleted: { $ne: true },
    };

    if (status) {
      query.status = status;
    }

    if (driver) {
      query.driver = new Types.ObjectId(driver);
    }

    if (search) {
      query.$or = [
        { trackingNumber: { $regex: search, $options: 'i' } },
        { 'customer.name': { $regex: search, $options: 'i' } },
        { 'customer.phone': { $regex: search, $options: 'i' } },
      ];
    }

    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      Delivery.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).exec(),
      Delivery.countDocuments(query).exec(),
    ]);

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async update(id: string, input: UpdateDeliveryInput): Promise<IDelivery> {
    if (!Types.ObjectId.isValid(id)) {
      throw new AppError('Invalid delivery ID', httpStatus.BAD_REQUEST);
    }

    const delivery = await Delivery.findByIdAndUpdate(
      id,
      { $set: input },
      { new: true, runValidators: true },
    );

    if (!delivery) {
      throw new AppError('Delivery not found', httpStatus.NOT_FOUND);
    }

    logger.info(`Delivery updated: ${delivery.trackingNumber}`);
    return delivery;
  }

  async archive(id: string, userId?: string): Promise<IDelivery> {
    if (!Types.ObjectId.isValid(id)) {
      throw new AppError('Invalid delivery ID', httpStatus.BAD_REQUEST);
    }

    const delivery = await Delivery.findById(id).setOptions({ includeDeleted: true });
    if (!delivery) {
      throw new AppError('Delivery not found', httpStatus.NOT_FOUND);
    }

    if (delivery.isDeleted) {
      throw new AppError('Delivery is already archived', httpStatus.CONFLICT);
    }

    return delivery.softDelete(userId);
  }

  async restore(id: string): Promise<IDelivery> {
    if (!Types.ObjectId.isValid(id)) {
      throw new AppError('Invalid delivery ID', httpStatus.BAD_REQUEST);
    }

    const delivery = await Delivery.findById(id).setOptions({ includeDeleted: true });
    if (!delivery) {
      throw new AppError('Delivery not found', httpStatus.NOT_FOUND);
    }

    if (!delivery.isDeleted) {
      throw new AppError('Delivery is not archived', httpStatus.CONFLICT);
    }

    return delivery.restore();
  }

  async listArchived(page = 1, limit = 10): Promise<PaginatedResult<IDelivery>> {
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      Delivery.find({ isDeleted: true })
        .setOptions({ includeDeleted: true })
        .sort({ deletedAt: -1 })
        .skip(skip)
        .limit(limit)
        .exec(),
      Delivery.countDocuments({ isDeleted: true }).setOptions({ includeDeleted: true }).exec(),
    ]);

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Advance a delivery to a new status and notify the parties involved.
   *
   * The transition is applied with a conditional update that asserts the
   * current status, so two concurrent requests cannot both advance the same
   * delivery — the loser matches no document and is rejected with a 409.
   *
   * Push notifications are dispatched after the write commits, and never
   * affect the outcome: a delivery that has moved to `completed` stays
   * completed even if the push provider is unreachable.
   *
   * @throws {AppError} 400 — invalid delivery id, or an illegal transition.
   * @throws {AppError} 404 — delivery not found.
   * @throws {AppError} 409 — the delivery changed status concurrently.
   */
  async updateStatus(id: string, nextStatus: DeliveryStatus): Promise<IDelivery> {
    if (!Types.ObjectId.isValid(id)) {
      throw new AppError('Invalid delivery ID', httpStatus.BAD_REQUEST);
    }

    const current = await deliveryRepository.findById(id);
    if (!current) {
      throw new AppError('Delivery not found', httpStatus.NOT_FOUND);
    }

    if (current.status === nextStatus) {
      throw new AppError(`Delivery is already in status '${nextStatus}'.`, httpStatus.CONFLICT);
    }

    const permitted = ALLOWED_TRANSITIONS[current.status] ?? [];
    if (!permitted.includes(nextStatus)) {
      throw new AppError(
        `Cannot transition a delivery from '${current.status}' to '${nextStatus}'.` +
          (permitted.length > 0
            ? ` Allowed next states: ${permitted.join(', ')}.`
            : ' This is a terminal state.'),
        httpStatus.BAD_REQUEST,
      );
    }

    if (nextStatus === DeliveryStatus.COMPLETED) {
      // Proof of delivery must be on record before a delivery can be marked
      // completed — this is what ultimately unblocks its escrow release.
      await proofOfDeliveryService.assertProofOfDeliveryExists(id);
    }

    const updated = await deliveryRepository.transitionStatus(id, current.status, nextStatus);

    if (!updated) {
      // The conditional update matched nothing, so the status changed between
      // the read above and the write — a concurrent transition won.
      throw new AppError(
        'Delivery status changed concurrently. Retry with the current state.',
        httpStatus.CONFLICT,
      );
    }

    logger.info(
      `[DeliveryService] Status transition — delivery=${id} ` +
        `${current.status} -> ${nextStatus}`,
    );

    // Fire-and-forget by design: notification/webhook failures are recorded
    // inside their own services and must not roll back a committed transition.
    await notificationService.notifyDeliveryTransition(updated, nextStatus);
    await webhookService.dispatchDeliveryEvent(updated, nextStatus);

    return updated;
  }

  /**
   * Assign a driver to a delivery, **only if the Soroban escrow contract for
   * that delivery is fully initialised (locked)**.
   *
   * Guard rules (checked in order):
   *   1. Delivery must exist and not be soft-deleted.
   *   2. Delivery must not already be in a terminal state (completed/cancelled).
   *   3. Delivery must not already have a driver assigned.
   *   4. An Escrow record must exist for the delivery.
   *   5. The escrow `lockStatus` must be `LOCKED`.
   *      - `PENDING`  → contract initialisation has not completed yet (409).
   *      - `RELEASED` / `REFUNDED` / `DISPUTED` → funds are no longer held (409).
   *      - Missing escrow record → contract was never initialised (422).
   *
   * On success the delivery `status` is advanced to `ASSIGNED` and the
   * `driverId` field is set.  Both writes happen in the same document save so
   * there is no partial-update window.
   *
   * @throws {AppError} 400 — invalid delivery id format.
   * @throws {AppError} 404 — delivery not found.
   * @throws {AppError} 409 — delivery already assigned, completed, or cancelled.
   * @throws {AppError} 422 — escrow record absent (contract never initialised).
   * @throws {AppError} 409 — escrow exists but is not in LOCKED state.
   */
  async assignDriver(input: AssignDriverInput): Promise<IDelivery> {
    const { deliveryId, driverId } = input;

    if (!Types.ObjectId.isValid(deliveryId)) {
      throw new AppError('Invalid delivery ID', httpStatus.BAD_REQUEST);
    }

    // ── 1. Load delivery ────────────────────────────────────────────────────
    const delivery = await Delivery.findById(deliveryId);
    if (!delivery) {
      throw new AppError('Delivery not found', httpStatus.NOT_FOUND);
    }

    // ── 2. Guard: terminal statuses ─────────────────────────────────────────
    if (
      delivery.status === DeliveryStatus.COMPLETED ||
      delivery.status === DeliveryStatus.CANCELLED
    ) {
      throw new AppError(
        `Cannot assign a driver to a delivery with status '${delivery.status}'.`,
        httpStatus.CONFLICT,
      );
    }

    // ── 3. Guard: already assigned ──────────────────────────────────────────
    if (delivery.status === DeliveryStatus.ASSIGNED) {
      throw new AppError(
        'A driver has already been assigned to this delivery.',
        httpStatus.CONFLICT,
      );
    }

    // ── 4. Load escrow record ───────────────────────────────────────────────
    const escrow = await Escrow.findOne({ delivery: delivery._id });

    if (!escrow) {
      logger.warn(
        `[DeliveryService] assignDriver blocked — no escrow record for delivery=${deliveryId}`,
      );
      throw new AppError(
        'Driver assignment is not allowed: the Soroban escrow contract for this delivery ' +
          'has not been initialised. Ensure the escrow is funded on-chain before assigning a driver.',
        httpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    // ── 5. Guard: escrow must be LOCKED ─────────────────────────────────────
    if (escrow.status !== EscrowStatus.LOCKED) {
      const statusDescriptions: Record<EscrowStatus, string> = {
        [EscrowStatus.PENDING]:
          'the escrow contract initialisation is still pending — funds have not been locked yet',
        [EscrowStatus.LOCKED]: '', // handled above (success path)
        [EscrowStatus.RELEASED]: 'the escrowed funds have already been released',
        [EscrowStatus.REFUNDED]: 'the escrowed funds have been refunded',
        [EscrowStatus.DISPUTED]: 'the escrow is currently under dispute',
        [EscrowStatus.EXPIRED]: 'the escrow lock has expired and is awaiting admin resolution',
        [EscrowStatus.RESOLVED]: 'the expired escrow has already been resolved by an admin',
      };

      const reason =
        statusDescriptions[escrow.status] ??
        `the escrow is in an unexpected state '${escrow.status}'`;

      logger.warn(
        `[DeliveryService] assignDriver blocked — escrow status=${escrow.status} ` +
          `delivery=${deliveryId}`,
      );

      throw new AppError(
        `Driver assignment rejected: ${reason}. ` +
          'The escrow contract must be in the LOCKED state before a driver can be assigned.',
        httpStatus.CONFLICT,
      );
    }

    // ── All guards passed — perform the assignment ──────────────────────────
    delivery.driverId = driverId;
    delivery.status = DeliveryStatus.ASSIGNED;
    const updated = await delivery.save();

    logger.info(
      `[DeliveryService] Driver assigned — delivery=${deliveryId} ` +
        `driver=${driverId} escrow=${String(escrow._id)}`,
    );

    return updated;
  }
}

export const deliveryService = new DeliveryService();
// ─── Handoff QR code (merged from legacy deliveryService.ts) ────────────────
//
// The legacy `deliveryService.ts` module provided `generateHandoffQrCode`.
// It was merged here so the canonical `deliveryService` singleton exposes the
// full delivery surface; the controller and DI container now share one import.

import QRCode from 'qrcode';
import { generateQrToken } from '../utils/qrToken';

export interface HandoffQrCodeResult {
  /** Base64 PNG data URL of the QR code. */
  qrCode: string;
  /** Signed verification token (kept out of API responses). */
  token: string;
  /** When the token expires. */
  expiresAt: Date;
  /** Delivery the QR code belongs to. */
  deliveryId: string;
}

class DeliveryServiceQrExtensions {
  /**
   * Generates a QR code for secure delivery handoff verification.
   * QR encodes delivery ID and a time-limited HMAC-signed token.
   */
  async generateHandoffQrCode(deliveryId: string): Promise<HandoffQrCodeResult> {
    const delivery = await Delivery.findById(deliveryId).lean();

    if (!delivery) {
      throw new AppError('Delivery not found', httpStatus.NOT_FOUND);
    }

    const eligibleStatuses: string[] = [DeliveryStatus.IN_PROGRESS];
    if (!eligibleStatuses.includes(String(delivery.status))) {
      throw new AppError(
        `Delivery is not eligible for handoff. Current status: ${delivery.status}`,
        httpStatus.BAD_REQUEST,
      );
    }

    const token = generateQrToken(deliveryId);
    const expiryMinutes = parseInt(process.env.QR_TOKEN_EXPIRY_MINUTES ?? '30', 10);
    const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000);

    const qrData = JSON.stringify({
      deliveryId,
      token,
      type: 'swiftchain_handoff',
    });

    const qrCode = await QRCode.toDataURL(qrData, {
      type: 'image/png',
      width: 300,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#FFFFFF',
      },
    });

    return { qrCode, token, expiresAt, deliveryId };
  }
}

/**
 * Attach the QR/handoff capability onto the canonical `deliveryService`
 * singleton via prototype delegation so `deliveryService.generateHandoffQrCode(id)`
 * works without changing controller call sites.
 */
DeliveryService.prototype.generateHandoffQrCode = async function (
  this: DeliveryService,
  deliveryId: string,
): Promise<HandoffQrCodeResult> {
  const qr = new DeliveryServiceQrExtensions();
  return qr.generateHandoffQrCode(deliveryId);
};
