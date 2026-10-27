/**
 * Escrow release must be blocked until proof of delivery is on record.
 *
 * Uses the real EscrowService, ProofOfDeliveryService and models on an
 * in-memory MongoDB. Only the Redis lock and the storage driver are mocked,
 * so the guard in releaseEscrow is exercised for real (escrow.e2e.test.ts
 * mocks the whole proof-of-delivery service and cannot cover it).
 */

import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { StatusCodes } from 'http-status-codes';
import Delivery, { DeliveryStatus } from '../src/models/Delivery';
import Escrow, { EscrowStatus } from '../src/models/Escrow';
import { escrowService } from '../src/services/escrow.service';
import { proofOfDeliveryService } from '../src/services/proofOfDeliveryService';

jest.mock('../src/config/redis', () => ({
  withLock: jest
    .fn()
    .mockImplementation(async (_resourceKey: string, fn: () => Promise<unknown>) => fn()),
}));

jest.mock('../src/services/storage.service', () => ({
  getStorageDriver: jest.fn(() => ({
    upload: jest.fn(async (_buffer: Buffer, key: string) => ({
      key,
      url: `https://cdn.example.com/${key}`,
    })),
  })),
}));

jest.mock('../src/config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await Promise.all([Delivery.init(), Escrow.init()]);
}, 120_000);

afterEach(async () => {
  await Promise.all([Delivery.deleteMany({}), Escrow.deleteMany({})]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

const DRIVER_ID = 'driver-1';

/** A locked escrow on an in-progress delivery assigned to DRIVER_ID. */
const createLockedEscrow = async (): Promise<{ deliveryId: string; escrowId: string }> => {
  const delivery = await Delivery.create({
    driverId: DRIVER_ID,
    status: DeliveryStatus.IN_PROGRESS,
    trackingNumber: `TRK-${new Types.ObjectId().toHexString().slice(-10)}`,
  });
  const escrow = await Escrow.create({
    delivery: delivery._id,
    status: EscrowStatus.LOCKED,
    amount: 10,
    assetCode: 'XLM',
    lockedAt: new Date(),
  });
  return { deliveryId: delivery.id, escrowId: escrow.id };
};

const releaseInput = (
  escrowId: string,
  transactionHash: string,
): Parameters<typeof escrowService.releaseEscrow>[0] => ({
  escrowId,
  transactionHash,
  ledger: 1000,
  releasedBy: 'system',
});

const uploadProof = (deliveryId: string): Promise<unknown> =>
  proofOfDeliveryService.uploadProofOfDelivery({
    deliveryId,
    uploadedBy: DRIVER_ID,
    originalName: 'handoff.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.from('image-bytes'),
    sizeBytes: 2048,
  });

describe('escrow release and proof of delivery', () => {
  it('rejects a release with 422 when no proof of delivery is on record', async () => {
    const { deliveryId, escrowId } = await createLockedEscrow();

    await expect(
      escrowService.releaseEscrow(releaseInput(escrowId, '0xrelease-without-proof')),
    ).rejects.toMatchObject({ statusCode: StatusCodes.UNPROCESSABLE_ENTITY });

    const escrow = await Escrow.findById(escrowId).lean();
    const delivery = await Delivery.findById(deliveryId).lean();
    expect(escrow?.status).toBe(EscrowStatus.LOCKED);
    expect(escrow?.transactions).toHaveLength(0);
    expect(escrow?.releasedAt).toBeUndefined();
    expect(delivery?.status).toBe(DeliveryStatus.IN_PROGRESS);
  });

  it('releases the escrow and completes the delivery once proof of delivery is uploaded', async () => {
    const { deliveryId, escrowId } = await createLockedEscrow();
    await uploadProof(deliveryId);

    const released = await escrowService.releaseEscrow(
      releaseInput(escrowId, '0xrelease-with-proof'),
    );

    expect(released.status).toBe(EscrowStatus.RELEASED);
    expect(released.transactions.map((tx) => tx.hash)).toContain('0xrelease-with-proof');
    const delivery = await Delivery.findById(deliveryId).lean();
    expect(delivery?.status).toBe(DeliveryStatus.COMPLETED);
  });

  it('still rejects a release after the proof was removed from the delivery', async () => {
    const { deliveryId, escrowId } = await createLockedEscrow();
    await uploadProof(deliveryId);
    await Delivery.updateOne({ _id: deliveryId }, { $unset: { proofOfDelivery: 1 } });

    await expect(
      escrowService.releaseEscrow(releaseInput(escrowId, '0xrelease-after-removal')),
    ).rejects.toMatchObject({ statusCode: StatusCodes.UNPROCESSABLE_ENTITY });
    expect((await Escrow.findById(escrowId).lean())?.status).toBe(EscrowStatus.LOCKED);
  });
});
