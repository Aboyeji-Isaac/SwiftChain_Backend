import mongoose from 'mongoose';
import sharp from 'sharp';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { profilePictureService } from '../../../src/services/profilePicture.service';
import { getStorageDriver } from '../../../src/services/storage.service';
import User from '../../../src/models/User';
import AppError from '../../../src/utils/AppError';
import { UserRole, UserStatus } from '../../../src/interfaces/IUser';

jest.mock('../../../src/config/database', () => ({
  connectDatabase: jest.fn(),
}));

jest.mock('../../../src/config/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

// The storage driver is faked so no file is written and no bucket is touched.
jest.mock('../../../src/services/storage.service', () => ({
  getStorageDriver: jest.fn(),
}));

const mockedGetStorageDriver = getStorageDriver as jest.MockedFunction<typeof getStorageDriver>;

const fakeDriver = {
  upload: jest.fn(),
  delete: jest.fn(),
};

// ─── In-memory MongoDB ─────────────────────────────────────────────────────────

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
}, 120_000);

beforeEach(() => {
  jest.clearAllMocks();
  mockedGetStorageDriver.mockReturnValue(fakeDriver);
  fakeDriver.upload.mockImplementation(async (_buffer: Buffer, name: string) => ({
    key: name,
    url: `https://cdn.example/${name}`,
  }));
  fakeDriver.delete.mockResolvedValue(undefined);
});

afterEach(async () => {
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    await collections[key].deleteMany({});
  }
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
}, 15_000);

// ─── Helpers ───────────────────────────────────────────────────────────────────

const createUser = async (
  overrides: Partial<{ profilePicture: string; profilePictureKey: string }> = {},
): Promise<InstanceType<typeof User>> =>
  User.create({
    firstName: 'Pic',
    lastName: 'User',
    email: `pic-${Date.now()}-${Math.random()}@example.com`,
    password: 'Password123!',
    role: UserRole.USER,
    status: UserStatus.ACTIVE,
    ...overrides,
  });

const makeImage = (width: number, height: number): Promise<Buffer> =>
  sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } },
  })
    .png()
    .toBuffer();

const expectAppError = async (promise: Promise<unknown>, statusCode: number): Promise<void> => {
  const error = await promise.then(
    () => {
      throw new Error('expected promise to reject');
    },
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).statusCode).toBe(statusCode);
};

// ─── Image processing pipeline ────────────────────────────────────────────────

describe('profilePictureService image processing', () => {
  it('resizes an oversized image to fit within 500px and encodes it as JPEG', async () => {
    const user = await createUser();
    const original = await makeImage(2000, 1000);

    await profilePictureService.uploadProfilePicture({
      userId: user._id.toString(),
      originalName: 'big.png',
      mimeType: 'image/png',
      buffer: original,
      sizeBytes: original.length,
    });

    const uploaded = fakeDriver.upload.mock.calls[0][0] as Buffer;
    const meta = await sharp(uploaded).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(500);
    expect(meta.height).toBe(250);
  });

  it('does not enlarge an image that is already smaller than the target', async () => {
    const user = await createUser();
    const small = await makeImage(120, 80);

    await profilePictureService.uploadProfilePicture({
      userId: user._id.toString(),
      originalName: 'small.png',
      mimeType: 'image/png',
      buffer: small,
      sizeBytes: small.length,
    });

    const meta = await sharp(fakeDriver.upload.mock.calls[0][0] as Buffer).metadata();
    expect(meta.width).toBe(120);
    expect(meta.height).toBe(80);
    expect(meta.format).toBe('jpeg');
  });

  it('rejects a payload that is not an image with a 500 processing error', async () => {
    const user = await createUser();
    const garbage = Buffer.from('this is definitely not an image');

    await expectAppError(
      profilePictureService.uploadProfilePicture({
        userId: user._id.toString(),
        originalName: 'fake.png',
        mimeType: 'image/png',
        buffer: garbage,
        sizeBytes: garbage.length,
      }),
      500,
    );
    expect(fakeDriver.upload).not.toHaveBeenCalled();
  });

  it('rejects an unsupported MIME type before processing', async () => {
    const user = await createUser();
    const image = await makeImage(10, 10);

    await expectAppError(
      profilePictureService.uploadProfilePicture({
        userId: user._id.toString(),
        originalName: 'doc.gif',
        mimeType: 'image/gif',
        buffer: image,
        sizeBytes: image.length,
      }),
      400,
    );
    expect(fakeDriver.upload).not.toHaveBeenCalled();
  });

  it('rejects a file larger than the configured maximum', async () => {
    const user = await createUser();
    const image = await makeImage(10, 10);

    await expectAppError(
      profilePictureService.uploadProfilePicture({
        userId: user._id.toString(),
        originalName: 'huge.png',
        mimeType: 'image/png',
        buffer: image,
        sizeBytes: 999 * 1024 * 1024,
      }),
      400,
    );
  });
});

// ─── Storage and user profile lifecycle ──────────────────────────────────────

describe('profilePictureService storage lifecycle', () => {
  it('stores the processed image under a profiles/<userId>/ key and updates the user', async () => {
    const user = await createUser();
    const image = await makeImage(50, 50);

    const result = await profilePictureService.uploadProfilePicture({
      userId: user._id.toString(),
      originalName: 'me.png',
      mimeType: 'image/png',
      buffer: image,
      sizeBytes: image.length,
    });

    const storedKey = fakeDriver.upload.mock.calls[0][1] as string;
    expect(storedKey).toMatch(new RegExp(`^profiles/${user._id.toString()}/\\d+-.+\\.png$`));

    const reloaded = await User.findById(user._id);
    expect(reloaded?.profilePictureKey).toBe(storedKey);
    expect(reloaded?.profilePicture).toBe(`https://cdn.example/${storedKey}`);
    expect(result.profilePictureKey).toBe(storedKey);
  });

  it('removes the previous file when the profile picture is replaced', async () => {
    const oldKey = `profiles/old-user/previous.jpg`;
    const user = await createUser({
      profilePicture: 'https://cdn.example/old',
      profilePictureKey: oldKey,
    });
    const image = await makeImage(50, 50);

    await profilePictureService.uploadProfilePicture({
      userId: user._id.toString(),
      originalName: 'new.png',
      mimeType: 'image/png',
      buffer: image,
      sizeBytes: image.length,
    });

    expect(fakeDriver.delete).toHaveBeenCalledTimes(1);
    expect(fakeDriver.delete).toHaveBeenCalledWith(oldKey);
  });

  it('surfaces a 500 when the storage driver fails to upload', async () => {
    const user = await createUser();
    const image = await makeImage(20, 20);
    fakeDriver.upload.mockRejectedValueOnce(new Error('bucket unreachable'));

    await expectAppError(
      profilePictureService.uploadProfilePicture({
        userId: user._id.toString(),
        originalName: 'x.png',
        mimeType: 'image/png',
        buffer: image,
        sizeBytes: image.length,
      }),
      500,
    );

    const reloaded = await User.findById(user._id);
    expect(reloaded?.profilePictureKey).toBeUndefined();
  });

  it('keeps the replacement successful when deleting the old file fails', async () => {
    const user = await createUser({
      profilePicture: 'https://cdn.example/old',
      profilePictureKey: 'profiles/old-user/stale.jpg',
    });
    const image = await makeImage(20, 20);
    fakeDriver.delete.mockRejectedValueOnce(new Error('S3 delete failed'));

    const result = await profilePictureService.uploadProfilePicture({
      userId: user._id.toString(),
      originalName: 'fresh.png',
      mimeType: 'image/png',
      buffer: image,
      sizeBytes: image.length,
    });

    expect(result.profilePictureKey).toBeDefined();
  });

  it('deletes the stored file and clears the profile fields', async () => {
    const key = 'profiles/del-user/current.jpg';
    const user = await createUser({
      profilePicture: 'https://cdn.example/x',
      profilePictureKey: key,
    });

    const removed = await profilePictureService.deleteProfilePicture(user._id.toString());

    expect(removed).toBe(true);
    expect(fakeDriver.delete).toHaveBeenCalledWith(key);
    const reloaded = await User.findById(user._id);
    expect(reloaded?.profilePictureKey).toBeUndefined();
    expect(reloaded?.profilePicture).toBeUndefined();
  });

  it('returns false and touches no storage when the user has no picture', async () => {
    const user = await createUser();

    const removed = await profilePictureService.deleteProfilePicture(user._id.toString());

    expect(removed).toBe(false);
    expect(fakeDriver.delete).not.toHaveBeenCalled();
  });
});

// ─── Validation helpers ───────────────────────────────────────────────────────

describe('profilePictureService.isValidImage', () => {
  it('returns true for a real image buffer', async () => {
    await expect(profilePictureService.isValidImage(await makeImage(4, 4))).resolves.toBe(true);
  });

  it('returns false for arbitrary bytes', async () => {
    await expect(
      profilePictureService.isValidImage(Buffer.from('plain text, not an image')),
    ).resolves.toBe(false);
  });
});
