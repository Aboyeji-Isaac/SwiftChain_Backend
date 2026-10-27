import { StatusCodes } from 'http-status-codes';
import mongoose, { SortOrder } from 'mongoose';
import Dispute, { DisputeReason, DisputeStatus, IDispute } from '../models/Dispute';
import Delivery, { DeliveryStatus } from '../models/Delivery';
import { sorobanService } from '../blockchain/soroban.service';
import AppError from '../utils/AppError';
import logger from '../config/logger';
import type {
  CreateDisputeInput,
  ResolveDisputeInput,
  AddEvidenceInput,
  UpdateDisputeInput,
  DisputeFilter,
} from '../validators/disputeValidator';

const ACTIVE_DELIVERY_STATUSES: DeliveryStatus[] = [
  DeliveryStatus.ASSIGNED,
  DeliveryStatus.IN_PROGRESS,
];

const populateOptions = [
  { path: 'raisedBy', select: 'firstName lastName email' },
  { path: 'deliveryId', select: 'deliveryId status userId driverId' },
];

export const createDispute = async (input: CreateDisputeInput): Promise<IDispute> => {
  const { deliveryId, raisedBy, reason, description, evidenceUrls } = input;

  if (!mongoose.Types.ObjectId.isValid(deliveryId)) {
    throw new AppError('Invalid delivery ID format.', StatusCodes.BAD_REQUEST);
  }

  const delivery = await Delivery.findById(deliveryId);
  if (!delivery) {
    throw new AppError('Delivery not found.', StatusCodes.NOT_FOUND);
  }

  if (!ACTIVE_DELIVERY_STATUSES.includes(delivery.status)) {
    throw new AppError(
      `Disputes can only be opened for deliveries that are assigned or in progress. Current status: '${delivery.status}'.`,
      StatusCodes.UNPROCESSABLE_ENTITY,
    );
  }

  const isParticipant = delivery.userId === raisedBy || delivery.driverId === raisedBy;
  if (!isParticipant) {
    throw new AppError(
      'Only the customer or driver associated with this delivery may open a dispute.',
      StatusCodes.FORBIDDEN,
    );
  }

  const existingOpenDispute = await Dispute.findOne({
    deliveryId,
    status: { $in: [DisputeStatus.OPEN, DisputeStatus.UNDER_REVIEW] },
  });
  if (existingOpenDispute) {
    throw new AppError(
      'An unresolved dispute already exists for this delivery.',
      StatusCodes.CONFLICT,
    );
  }

  let raisedAtLedger: number | undefined;
  try {
    const latest = await sorobanService.getLatestLedger();
    raisedAtLedger = typeof latest === 'number' ? latest : undefined;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.warn(`[Dispute] Failed to fetch latest Soroban ledger for audit stamp: ${message}`);
  }

  const dispute = await Dispute.create({
    deliveryId,
    raisedBy,
    reason,
    description,
    evidenceUrls,
    status: DisputeStatus.OPEN,
    raisedAtLedger,
  });

  logger.info(
    `[Dispute] User ${raisedBy} opened dispute ${dispute._id} for delivery ${deliveryId}`,
  );

  return dispute;
};

export const getDisputeById = async (id: string): Promise<IDispute> => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new AppError('Invalid dispute ID format.', StatusCodes.BAD_REQUEST);
  }

  const dispute = await Dispute.findById(id).populate(populateOptions);
  if (!dispute) {
    throw new AppError('Dispute not found.', StatusCodes.NOT_FOUND);
  }

  return dispute;
};

export const getDisputes = async (
  filters: Pick<DisputeFilter, 'page' | 'limit'> & {
    /** Whitelisted filter produced by the shared query middleware. */
    filter?: Record<string, unknown>;
    sort?: Record<string, SortOrder>;
  },
) => {
  const { filter = {}, page = 1, limit = 10, sort = { createdAt: -1 } } = filters;
  const query: Record<string, unknown> = { ...filter };

  if (typeof query.raisedBy === 'string' && !mongoose.Types.ObjectId.isValid(query.raisedBy)) {
    throw new AppError('Invalid raisedBy format.', StatusCodes.BAD_REQUEST);
  }

  if (typeof query.deliveryId === 'string' && !mongoose.Types.ObjectId.isValid(query.deliveryId)) {
    throw new AppError('Invalid deliveryId format.', StatusCodes.BAD_REQUEST);
  }

  const skip = (page - 1) * limit;
  const [data, total] = await Promise.all([
    Dispute.find(query).populate(populateOptions).sort(sort).skip(skip).limit(limit).exec(),
    Dispute.countDocuments(query).exec(),
  ]);

  return {
    data,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
};

export const resolveDispute = async (id: string, input: ResolveDisputeInput): Promise<IDispute> => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new AppError('Invalid dispute ID format.', StatusCodes.BAD_REQUEST);
  }

  const dispute = await Dispute.findById(id);
  if (!dispute) {
    throw new AppError('Dispute not found.', StatusCodes.NOT_FOUND);
  }

  if (dispute.status === DisputeStatus.RESOLVED || dispute.status === DisputeStatus.REJECTED) {
    throw new AppError(
      `Dispute is already ${dispute.status} and cannot be resolved again.`,
      StatusCodes.CONFLICT,
    );
  }

  if (input.status === DisputeStatus.RESOLVED && !input.resolutionNotes) {
    throw new AppError(
      'resolutionNotes are required when resolving a dispute.',
      StatusCodes.UNPROCESSABLE_ENTITY,
    );
  }

  dispute.status = input.status;
  dispute.resolutionNotes = input.resolutionNotes;
  dispute.resolvedBy = input.resolvedBy;
  dispute.resolvedAt = new Date();

  await dispute.save();

  logger.info(`[Dispute] Dispute ${id} updated to status '${input.status}' by ${input.resolvedBy}`);

  return dispute;
};

export const addEvidence = async (id: string, input: AddEvidenceInput): Promise<IDispute> => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new AppError('Invalid dispute ID format.', StatusCodes.BAD_REQUEST);
  }

  const dispute = await Dispute.findById(id);
  if (!dispute) {
    throw new AppError('Dispute not found.', StatusCodes.NOT_FOUND);
  }

  if (dispute.status === DisputeStatus.RESOLVED || dispute.status === DisputeStatus.REJECTED) {
    throw new AppError(
      'Evidence cannot be added to a resolved or rejected dispute.',
      StatusCodes.CONFLICT,
    );
  }

  const existingUrls = dispute.evidenceUrls || [];
  const newUrls = input.evidenceUrls.filter((url) => !existingUrls.includes(url));
  dispute.evidenceUrls = [...existingUrls, ...newUrls];

  await dispute.save();

  logger.info(`[Dispute] ${newUrls.length} evidence URLs added to dispute ${id}`);

  return dispute;
};

export const updateDispute = async (id: string, input: UpdateDisputeInput): Promise<IDispute> => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new AppError('Invalid dispute ID format.', StatusCodes.BAD_REQUEST);
  }

  const dispute = await Dispute.findById(id);
  if (!dispute) {
    throw new AppError('Dispute not found.', StatusCodes.NOT_FOUND);
  }

  if (dispute.status === DisputeStatus.RESOLVED || dispute.status === DisputeStatus.REJECTED) {
    throw new AppError('A resolved or rejected dispute cannot be modified.', StatusCodes.CONFLICT);
  }

  if (input.reason !== undefined) {
    dispute.reason = input.reason;
  }
  if (input.description !== undefined) {
    dispute.description = input.description;
  }
  if (input.evidenceUrls !== undefined) {
    dispute.evidenceUrls = input.evidenceUrls;
  }

  await dispute.save();

  logger.info(`[Dispute] Dispute ${id} updated`);

  return dispute;
};

// ─── Indexer event handlers ─────────────────────────────────────────────────
//
// The Soroban dispute events arrive through the indexer with on-chain
// identifiers rather than Mongo ids, so these helpers intentionally use
// `disputeId` as the lookup key and never throw for unknown entities:
// the indexer may observe events out of strict ledger order.

export interface DisputeOpenedEventInput {
  disputeId: string;
  deliveryId: string;
  openedBy?: string;
  reason?: string;
  ledgerSequence: number;
}

export interface DisputeResolvedEventInput {
  disputeId: string;
  resolution?: string;
  ledgerSequence: number;
}

/** List disputes with optional status filter (used by tests and admin views). */
export const listDisputes = async (
  page = 1,
  limit = 20,
  status?: DisputeStatus,
): Promise<{
  data: IDispute[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}> => {
  const query: Record<string, unknown> = status ? { status } : {};
  const [data, total] = await Promise.all([
    Dispute.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .exec(),
    Dispute.countDocuments(query).exec(),
  ]);

  return {
    data,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
};

/** Fetch a dispute by its on-chain identifier. */
export const getDisputeByDisputeId = async (disputeId: string): Promise<IDispute> => {
  const dispute = await Dispute.findOne({ disputeId });
  if (!dispute) {
    throw new AppError(`Dispute '${disputeId}' not found.`, StatusCodes.NOT_FOUND);
  }
  return dispute;
};

/**
 * Handle a `dispute_opened` indexer event: persist the dispute locally.
 * Idempotent — repeated events for the same on-chain disputeId are no-ops.
 */
export const openDisputeFromEvent = async (input: DisputeOpenedEventInput): Promise<IDispute> => {
  const { disputeId, deliveryId, openedBy, reason, ledgerSequence } = input;

  if (!disputeId || !deliveryId) {
    throw new AppError('disputeId and deliveryId are required.', StatusCodes.BAD_REQUEST);
  }

  const existing = await Dispute.findOne({ disputeId });
  if (existing) {
    return existing;
  }

  const dispute = await Dispute.create({
    disputeId,
    deliveryId,
    openedBy,
    raisedBy: openedBy ?? 'on-chain',
    reason: DisputeReason.OTHER,
    description: reason ?? 'Dispute opened on-chain.',
    status: DisputeStatus.OPEN,
    openedLedger: ledgerSequence,
  });

  logger.info(
    `[Dispute] On-chain dispute ${disputeId} recorded for delivery ${deliveryId} ` +
      `(ledger ${ledgerSequence})`,
  );

  return dispute;
};

/**
 * Handle a `dispute_resolved` indexer event. Unknown disputes are logged and
 * ignored rather than thrown — the indexer can observe events out of order.
 */
export const resolveDisputeFromEvent = async (
  input: DisputeResolvedEventInput,
): Promise<IDispute | null> => {
  const { disputeId, resolution, ledgerSequence } = input;

  const dispute = await Dispute.findOne({ disputeId });
  if (!dispute) {
    logger.warn(`[Dispute] dispute_resolved for unknown disputeId=${disputeId} — ignoring`);
    return null;
  }

  dispute.status = DisputeStatus.RESOLVED;
  dispute.resolution = resolution;
  dispute.resolvedLedger = ledgerSequence;
  dispute.resolvedAt = new Date();

  await dispute.save();

  logger.info(`[Dispute] On-chain dispute ${disputeId} resolved at ledger ${ledgerSequence}`);

  return dispute;
};

/**
 * Event-facing facade consumed by src/indexer/disputeHandlers.ts.
 * Registered on the module namespace so `import { disputeService }` works
 * exactly like the other function-module services in this codebase.
 */
export const disputeService = {
  openDispute: (input: DisputeOpenedEventInput): Promise<IDispute> => openDisputeFromEvent(input),
  resolveDispute: (input: DisputeResolvedEventInput): Promise<IDispute | null> =>
    resolveDisputeFromEvent(input),
  listDisputes,
  getDisputeByDisputeId,
  getDisputeById: async (disputeId: string): Promise<IDispute> => {
    const dispute = await Dispute.findOne({ disputeId });
    if (!dispute) {
      throw new AppError(`Dispute '${disputeId}' not found.`, StatusCodes.NOT_FOUND);
    }
    return dispute;
  },
};
