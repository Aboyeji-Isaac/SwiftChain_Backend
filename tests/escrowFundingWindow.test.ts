/**
 * Escrow funding-window tests (issue #247).
 *
 * Covers:
 *  - `fundBy` defaulting at delivery creation (ESCROW_FUNDING_WINDOW_SECONDS)
 *  - lapse boundaries of the funding-window scan (before / at / after fundBy,
 *    plus funded and archived deliveries that must never be cancelled)
 *  - the cron entry point (`runFundingWindowScan` / `runEscrowMonitorTick`)
 *  - the reject-after-cancel path for `POST /api/v1/escrow/fund`
 *  - the `funding_window_lapsed` milestone and the audit-log entry
 *
 * Uses mongodb-memory-server so Delivery/DeliveryEvent/AuditLog interactions
 * are exercised against a real (in-process) MongoDB instead of mocks.
 */

import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  escrowService,
  FUNDING_WINDOW_LAPSED_REASON,
  type EscrowFundedInput,
} from '../src/services/escrow.service';
import { deliveryService, type CreateDeliveryInput } from '../src/services/delivery.service';
import { runFundingWindowScan, runEscrowMonitorTick } from '../src/jobs/escrowMonitor';
import Delivery, { DeliveryStatus, type IDelivery } from '../src/models/Delivery';
import DeliveryEvent, { DeliveryMilestone } from '../src/models/DeliveryEvent';
import AuditLog from '../src/models/AuditLog';
import Escrow, { EscrowStatus } from '../src/models/Escrow';
import env from '../src/config/env';

jest.mock('../src/config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

// The monitor tick also runs the escrow-expiry scan, which stamps the latest
// Soroban ledger onto flagged escrows — keep that RPC call out of unit tests.
jest.mock('../src/blockchain/soroban.service', () => ({
  sorobanService: {
    getLatestLedger: jest.fn().mockResolvedValue(999999),
  },
}));

let sequence = 0;
const nextTrackingNumber = (): string => `FW-${Date.now()}-${++sequence}`;

/** Minimal but valid create-delivery payload. */
const createDeliveryInput = (escrowAmount: number): CreateDeliveryInput => ({
  trackingNumber: nextTrackingNumber(),
  customer: { name: 'Window Tester', phone: '+15550001111' },
  pickup: { address: '1 Pickup St' },
  dropoff: { address: '2 Dropoff Ave' },
  package: { description: 'Parcel', weight: 1 },
  deliveryFee: 10,
  escrowAmount,
});

describe('Escrow funding window (issue #247)', () => {
  let mongod: MongoMemoryServer;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
  }, 60_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  }, 30_000);

  afterEach(async () => {
    await Promise.all([
      Delivery.deleteMany({}),
      DeliveryEvent.deleteMany({}),
      AuditLog.deleteMany({}),
      Escrow.deleteMany({}),
    ]);
  });

  describe('fundBy at creation', () => {
    it('defaults fundBy to now + ESCROW_FUNDING_WINDOW_SECONDS when an escrow is configured', async () => {
      const before = Date.now();
      const delivery = await deliveryService.create(createDeliveryInput(150));

      expect(delivery.fundBy).toBeInstanceOf(Date);
      const expectedMin = before + env.ESCROW_FUNDING_WINDOW_SECONDS * 1000;
      const expectedMax = Date.now() + env.ESCROW_FUNDING_WINDOW_SECONDS * 1000;
      expect(delivery.fundBy!.getTime()).toBeGreaterThanOrEqual(expectedMin);
      expect(delivery.fundBy!.getTime()).toBeLessThanOrEqual(expectedMax);
    });

    it('does not set fundBy when no escrow amount is configured', async () => {
      const delivery = await deliveryService.create(createDeliveryInput(0));
      expect(delivery.fundBy).toBeUndefined();
    });

    it('honours an explicit fundBy override', async () => {
      const explicit = new Date(Date.now() + 5 * 60 * 1000);
      const delivery = await deliveryService.create({
        ...createDeliveryInput(150),
        fundBy: explicit,
      });
      expect(delivery.fundBy!.getTime()).toBe(explicit.getTime());
    });
  });

  describe('scanLapsedFundingWindows — lapse boundaries', () => {
    const seed = (overrides: Record<string, unknown> = {}): Promise<IDelivery> =>
      Delivery.create({
        deliveryId: `DEL-${new Types.ObjectId().toHexString()}`,
        trackingNumber: nextTrackingNumber(),
        status: DeliveryStatus.PENDING,
        escrowAmount: 100,
        ...overrides,
      });

    it('cancels a pending delivery whose fundBy has passed', async () => {
      const delivery = await seed({ fundBy: new Date(Date.now() - 1000) });

      const result = await escrowService.scanLapsedFundingWindows();

      expect(result.cancelledCount).toBe(1);
      expect(result.cancelledDeliveryIds).toContain(String(delivery._id));

      const updated = await Delivery.findById(delivery._id);
      expect(updated!.status).toBe(DeliveryStatus.CANCELLED);
      expect(updated!.cancellationReason).toBe(FUNDING_WINDOW_LAPSED_REASON);
    });

    it('leaves a delivery alone while the window is still open', async () => {
      await seed({ fundBy: new Date(Date.now() + 60_000) });

      const result = await escrowService.scanLapsedFundingWindows();

      expect(result.cancelledCount).toBe(0);
      const remaining = await Delivery.findOne({ status: DeliveryStatus.PENDING });
      expect(remaining).not.toBeNull();
    });

    it('cancels exactly at the fundBy boundary (<= now counts as lapsed)', async () => {
      const delivery = await seed({ fundBy: new Date(Date.now() - 1) });

      await escrowService.scanLapsedFundingWindows();

      const updated = await Delivery.findById(delivery._id);
      expect(updated!.status).toBe(DeliveryStatus.CANCELLED);
    });

    it('never cancels a delivery that was already funded', async () => {
      const delivery = await seed({
        status: DeliveryStatus.FUNDED,
        fundBy: new Date(Date.now() - 60_000),
      });

      const result = await escrowService.scanLapsedFundingWindows();

      expect(result.cancelledCount).toBe(0);
      const updated = await Delivery.findById(delivery._id);
      expect(updated!.status).toBe(DeliveryStatus.FUNDED);
    });

    it('never cancels an archived (soft-deleted) delivery', async () => {
      const delivery = await seed({
        fundBy: new Date(Date.now() - 60_000),
        isDeleted: true,
        deletedAt: new Date(),
      });

      const result = await escrowService.scanLapsedFundingWindows();

      expect(result.cancelledCount).toBe(0);
      const updated = await Delivery.findById(delivery._id);
      expect(updated!.status).toBe(DeliveryStatus.PENDING);
    });

    it('is idempotent — a second pass cancels nothing new', async () => {
      await seed({ fundBy: new Date(Date.now() - 1000) });

      const first = await escrowService.scanLapsedFundingWindows();
      const second = await escrowService.scanLapsedFundingWindows();

      expect(first.cancelledCount).toBe(1);
      expect(second.cancelledCount).toBe(0);
    });
  });

  describe('funding_window_lapsed milestone and audit log', () => {
    it('records the milestone with from/to statuses and the deadline payload', async () => {
      const fundBy = new Date(Date.now() - 5000);
      const delivery = await Delivery.create({
        deliveryId: `DEL-${new Types.ObjectId().toHexString()}`,
        trackingNumber: nextTrackingNumber(),
        status: DeliveryStatus.PENDING,
        escrowAmount: 100,
        fundBy,
      });

      await escrowService.scanLapsedFundingWindows();

      const event = await DeliveryEvent.findOne({ delivery: delivery._id });
      expect(event).not.toBeNull();
      expect(event!.event).toBe(DeliveryMilestone.FUNDING_WINDOW_LAPSED);
      expect(event!.fromStatus).toBe(DeliveryStatus.PENDING);
      expect(event!.toStatus).toBe(DeliveryStatus.CANCELLED);
      expect(event!.seq).toBe(1);
      expect(event!.payload).toMatchObject({
        reason: FUNDING_WINDOW_LAPSED_REASON,
        fundBy: fundBy.toISOString(),
      });
    });

    it('writes an audit-log entry for the cancellation', async () => {
      const delivery = await Delivery.create({
        deliveryId: `DEL-${new Types.ObjectId().toHexString()}`,
        trackingNumber: nextTrackingNumber(),
        status: DeliveryStatus.PENDING,
        escrowAmount: 100,
        fundBy: new Date(Date.now() - 5000),
      });

      await escrowService.scanLapsedFundingWindows();

      const audit = await AuditLog.findOne({
        action: 'funding_window_lapsed',
        targetId: delivery._id,
      });
      expect(audit).not.toBeNull();
      expect(audit!.targetType).toBe('delivery');
      expect(audit!.description).toBe(FUNDING_WINDOW_LAPSED_REASON);
      expect(audit!.meta).toMatchObject({
        deliveryId: String(delivery._id),
        fromStatus: DeliveryStatus.PENDING,
        toStatus: DeliveryStatus.CANCELLED,
      });
    });
  });

  describe('reject-after-cancel on fund requests', () => {
    const seed = (overrides: Record<string, unknown> = {}): Promise<IDelivery> =>
      Delivery.create({
        deliveryId: `DEL-${new Types.ObjectId().toHexString()}`,
        trackingNumber: nextTrackingNumber(),
        status: DeliveryStatus.PENDING,
        escrowAmount: 100,
        ...overrides,
      });

    const fundPayload = (deliveryId: string, transactionHash: string): EscrowFundedInput => ({
      contractId: `CFUND-${transactionHash}`,
      deliveryId,
      amount: 100,
      asset: 'XLM',
      fundedBy: 'GTESTFUNDER',
      transactionHash,
      ledger: 42,
    });

    it('rejects funding for an already-cancelled delivery with a clear 409', async () => {
      const delivery = await seed({ status: DeliveryStatus.CANCELLED });

      const error = await escrowService
        .recordEscrowFunded(fundPayload(String(delivery._id), 'tx-cancelled'))
        .catch((err: Error & { statusCode?: number }) => err);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/cancelled/i);
      expect((error as Error).message).toMatch(/no longer be funded/i);
      expect((error as { statusCode?: number }).statusCode).toBe(409);

      // The delivery must stay cancelled — funding never resurrects it.
      const updated = await Delivery.findById(delivery._id);
      expect(updated!.status).toBe(DeliveryStatus.CANCELLED);
      expect(await Escrow.countDocuments({})).toBe(0);
    });

    it('cancels inline when a fund request arrives after fundBy, then rejects it', async () => {
      const delivery = await seed({ fundBy: new Date(Date.now() - 1000) });

      await expect(
        escrowService.recordEscrowFunded(fundPayload(String(delivery._id), 'tx-late')),
      ).rejects.toMatchObject({ statusCode: 409 });

      const updated = await Delivery.findById(delivery._id);
      expect(updated!.status).toBe(DeliveryStatus.CANCELLED);
      expect(updated!.cancellationReason).toBe(FUNDING_WINDOW_LAPSED_REASON);

      // The lapse was observable: milestone + audit log were both written.
      const event = await DeliveryEvent.findOne({ delivery: delivery._id });
      expect(event!.event).toBe(DeliveryMilestone.FUNDING_WINDOW_LAPSED);
      const audit = await AuditLog.findOne({ action: 'funding_window_lapsed' });
      expect(audit).not.toBeNull();

      // Nothing was escrowed for the rejected funding attempt.
      expect(await Escrow.countDocuments({})).toBe(0);
    });

    it('accepts funding while the window is still open', async () => {
      const delivery = await seed({ fundBy: new Date(Date.now() + 60_000) });

      const escrow = await escrowService.recordEscrowFunded(
        fundPayload(String(delivery._id), 'tx-intime'),
      );

      expect(escrow.status).toBe(EscrowStatus.LOCKED);
      const updated = await Delivery.findById(delivery._id);
      expect(updated!.status).toBe(DeliveryStatus.FUNDED);
      expect(updated!.cancellationReason).toBeUndefined();
    });
  });

  describe('escrow monitor cron job', () => {
    it('runFundingWindowScan cancels lapsed deliveries on demand', async () => {
      const delivery = await Delivery.create({
        deliveryId: `DEL-${new Types.ObjectId().toHexString()}`,
        trackingNumber: nextTrackingNumber(),
        status: DeliveryStatus.PENDING,
        escrowAmount: 100,
        fundBy: new Date(Date.now() - 1000),
      });

      await runFundingWindowScan();

      const updated = await Delivery.findById(delivery._id);
      expect(updated!.status).toBe(DeliveryStatus.CANCELLED);
    });

    it('a full monitor tick runs both scans and cancels lapsed deliveries', async () => {
      const delivery = await Delivery.create({
        deliveryId: `DEL-${new Types.ObjectId().toHexString()}`,
        trackingNumber: nextTrackingNumber(),
        status: DeliveryStatus.PENDING,
        escrowAmount: 100,
        fundBy: new Date(Date.now() - 1000),
      });

      await runEscrowMonitorTick();

      const updated = await Delivery.findById(delivery._id);
      expect(updated!.status).toBe(DeliveryStatus.CANCELLED);
      // No escrows in this fixture, so the expiry scan is a clean no-op.
      expect(await Escrow.countDocuments({})).toBe(0);
    });
  });
});
