/**
 * Unit tests for ProofOfDeliveryService.
 *
 * Persistence runs against a real in-process MongoDB so the stored proof
 * metadata and the escrow-release guard are checked against actual documents.
 * Only the storage driver is replaced, since it talks to local disk or S3.
 */

import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { StatusCodes } from 'http-status-codes';
import Delivery, { DeliveryStatus } from '../src/models/Delivery';
import env from '../src/config/env';
import {
  ProofOfDeliveryService,
  UploadProofOfDeliveryInput,
} from '../src/services/proofOfDeliveryService';

const mockUpload = jest.fn();

jest.mock('../src/services/storage.service', () => ({
  getStorageDriver: jest.fn(() => ({ upload: mockUpload })),
}));

jest.mock('../src/config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: MongoMemoryServer;
let service: ProofOfDeliveryService;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  service = new ProofOfDeliveryService();
}, 120_000);

beforeEach(() => {
  mockUpload.mockReset();
  mockUpload.mockImplementation(async (_buffer: Buffer, key: string) => ({
    key,
    url: `https://cdn.example.com/${key}`,
  }));
});

afterEach(async () => {
  await Delivery.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

const MAX_BYTES = env.PROOF_OF_DELIVERY_MAX_SIZE_MB * 1024 * 1024;

const createDelivery = async (
  overrides: Partial<{ driverId: string; status: DeliveryStatus }> = {},
): Promise<InstanceType<typeof Delivery>> => {
  return Delivery.create({
    driverId: overrides.driverId,
    status: overrides.status ?? DeliveryStatus.IN_PROGRESS,
    trackingNumber: `TRK-${new Types.ObjectId().toHexString().slice(-10)}`,
  });
};

const uploadInput = (
  deliveryId: string,
  overrides: Partial<{
    uploadedBy: string;
    mimeType: string;
    sizeBytes: number;
    originalName: string;
  }> = {},
): UploadProofOfDeliveryInput => ({
  deliveryId,
  uploadedBy: overrides.uploadedBy ?? 'driver-1',
  originalName: overrides.originalName ?? 'photo.jpg',
  mimeType: overrides.mimeType ?? 'image/jpeg',
  buffer: Buffer.from('image-bytes'),
  sizeBytes: overrides.sizeBytes ?? 1024,
});

/** Assert that a promise rejects with an AppError carrying the given status. */
const expectAppError = async (promise: Promise<unknown>, statusCode: number): Promise<void> => {
  await expect(promise).rejects.toMatchObject({ statusCode });
};

describe('ProofOfDeliveryService', () => {
  describe('MIME type allow-list', () => {
    it.each(['image/jpeg', 'image/png', 'image/webp'])('accepts %s uploads', async (mimeType) => {
      const delivery = await createDelivery({ driverId: 'driver-1' });

      const updated = await service.uploadProofOfDelivery(
        uploadInput(delivery.id, { mimeType, originalName: 'proof' }),
      );

      expect(updated.proofOfDelivery?.mimeType).toBe(mimeType);
      expect(mockUpload).toHaveBeenCalledTimes(1);
    });

    it.each(['image/gif', 'application/pdf', 'text/html', 'image/svg+xml'])(
      'rejects %s with 415',
      async (mimeType) => {
        const delivery = await createDelivery({ driverId: 'driver-1' });

        await expectAppError(
          service.uploadProofOfDelivery(uploadInput(delivery.id, { mimeType })),
          StatusCodes.UNSUPPORTED_MEDIA_TYPE,
        );
        expect(mockUpload).not.toHaveBeenCalled();
      },
    );
  });

  describe('size cap', () => {
    it('accepts a file exactly at the configured maximum', async () => {
      const delivery = await createDelivery({ driverId: 'driver-1' });

      const updated = await service.uploadProofOfDelivery(
        uploadInput(delivery.id, { sizeBytes: MAX_BYTES }),
      );

      expect(updated.proofOfDelivery?.sizeBytes).toBe(MAX_BYTES);
    });

    it('rejects a file one byte over the configured maximum with 413', async () => {
      const delivery = await createDelivery({ driverId: 'driver-1' });

      await expectAppError(
        service.uploadProofOfDelivery(uploadInput(delivery.id, { sizeBytes: MAX_BYTES + 1 })),
        StatusCodes.REQUEST_TOO_LONG,
      );
      expect(mockUpload).not.toHaveBeenCalled();
    });
  });

  describe('upload', () => {
    it('stores the file under a delivery-scoped key and persists proof metadata', async () => {
      const delivery = await createDelivery({ driverId: 'driver-1' });

      const updated = await service.uploadProofOfDelivery(
        uploadInput(delivery.id, { originalName: 'front-door.png', mimeType: 'image/png' }),
      );

      const expectedKey = `proof-of-delivery/${delivery.id}/front-door.png`;
      expect(mockUpload).toHaveBeenCalledWith(expect.any(Buffer), expectedKey, 'image/png');

      const persisted = await Delivery.findById(delivery.id).lean();
      expect(persisted?.proofOfDelivery).toMatchObject({
        storageKey: expectedKey,
        imageUrl: `https://cdn.example.com/${expectedKey}`,
        storageDriver: env.UPLOAD_STORAGE_DRIVER,
        mimeType: 'image/png',
        sizeBytes: 1024,
        uploadedBy: 'driver-1',
      });
      expect(persisted?.proofOfDelivery?.uploadedAt).toBeInstanceOf(Date);
      expect(updated.id).toBe(delivery.id);
    });

    it('replaces an existing proof when the driver uploads again', async () => {
      const delivery = await createDelivery({ driverId: 'driver-1' });
      await service.uploadProofOfDelivery(uploadInput(delivery.id, { originalName: 'first.jpg' }));

      await service.uploadProofOfDelivery(uploadInput(delivery.id, { originalName: 'second.jpg' }));

      const persisted = await Delivery.findById(delivery.id).lean();
      expect(persisted?.proofOfDelivery?.storageKey).toContain('second.jpg');
    });
  });

  describe('authorization', () => {
    it('rejects an uploader who is not the assigned driver with 403', async () => {
      const delivery = await createDelivery({ driverId: 'driver-1' });

      await expectAppError(
        service.uploadProofOfDelivery(uploadInput(delivery.id, { uploadedBy: 'driver-2' })),
        StatusCodes.FORBIDDEN,
      );
      expect(mockUpload).not.toHaveBeenCalled();
    });
  });

  describe('delivery state and lookup errors', () => {
    it.each([DeliveryStatus.COMPLETED, DeliveryStatus.CANCELLED])(
      'rejects uploads for a %s delivery with 409',
      async (status) => {
        const delivery = await createDelivery({ driverId: 'driver-1', status });

        await expectAppError(
          service.uploadProofOfDelivery(uploadInput(delivery.id)),
          StatusCodes.CONFLICT,
        );
      },
    );

    it('returns 400 for a malformed delivery id', async () => {
      await expectAppError(
        service.uploadProofOfDelivery(uploadInput('not-an-object-id')),
        StatusCodes.BAD_REQUEST,
      );
    });

    it('returns 404 when the delivery does not exist', async () => {
      await expectAppError(
        service.uploadProofOfDelivery(uploadInput(new Types.ObjectId().toHexString())),
        StatusCodes.NOT_FOUND,
      );
    });
  });

  describe('getProofOfDelivery', () => {
    it('returns null when no proof has been uploaded', async () => {
      const delivery = await createDelivery({ driverId: 'driver-1' });

      expect(await service.getProofOfDelivery(delivery.id)).toBeNull();
    });

    it('returns the stored proof record', async () => {
      const delivery = await createDelivery({ driverId: 'driver-1' });
      await service.uploadProofOfDelivery(uploadInput(delivery.id));

      const proof = await service.getProofOfDelivery(delivery.id);

      expect(proof?.uploadedBy).toBe('driver-1');
    });

    it('returns 400 for a malformed id and 404 for an unknown delivery', async () => {
      await expectAppError(service.getProofOfDelivery('bad-id'), StatusCodes.BAD_REQUEST);
      await expectAppError(
        service.getProofOfDelivery(new Types.ObjectId().toHexString()),
        StatusCodes.NOT_FOUND,
      );
    });
  });

  describe('assertProofOfDeliveryExists (escrow release guard)', () => {
    it('passes when proof of delivery is on record', async () => {
      const delivery = await createDelivery({ driverId: 'driver-1' });
      await service.uploadProofOfDelivery(uploadInput(delivery.id));

      await expect(service.assertProofOfDeliveryExists(delivery.id)).resolves.toBeUndefined();
    });

    it('throws 422 when no proof has been uploaded', async () => {
      const delivery = await createDelivery({ driverId: 'driver-1' });

      await expectAppError(
        service.assertProofOfDeliveryExists(delivery.id),
        StatusCodes.UNPROCESSABLE_ENTITY,
      );
    });

    it('throws 422 when the delivery does not exist', async () => {
      await expectAppError(
        service.assertProofOfDeliveryExists(new Types.ObjectId().toHexString()),
        StatusCodes.UNPROCESSABLE_ENTITY,
      );
    });

    it('throws 400 for a malformed id', async () => {
      await expectAppError(
        service.assertProofOfDeliveryExists('not-valid'),
        StatusCodes.BAD_REQUEST,
      );
    });
  });
});
