import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  LocalStorageDriver,
  S3StorageDriver,
  getStorageDriver,
  resetStorageDriverCache,
} from '../../../src/services/storage.service';
import env from '../../../src/config/env';

jest.mock('../../../src/config/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(),
}));

const mockedGetSignedUrl = getSignedUrl as jest.MockedFunction<typeof getSignedUrl>;

// ─── Local disk driver ─────────────────────────────────────────────────────────

describe('LocalStorageDriver', () => {
  let uploadDir: string;
  let driver: LocalStorageDriver;

  beforeEach(async () => {
    uploadDir = await fs.mkdtemp(path.join(os.tmpdir(), 'swiftchain-storage-'));
    driver = new LocalStorageDriver(uploadDir);
  });

  afterEach(async () => {
    await fs.rm(uploadDir, { recursive: true, force: true });
  });

  it('round-trips a file through upload, read and delete', async () => {
    const payload = Buffer.from('evidence-bytes');

    const stored = await driver.upload(payload, 'photo.JPG', 'image/jpeg');

    expect(stored.key).toMatch(/^evidence\/\d+-[0-9a-f-]{36}\.jpg$/);
    expect(stored.url).toMatch(/\/uploads\/evidence\/.+\.jpg$/);

    const onDisk = await fs.readFile(path.join(uploadDir, stored.key));
    expect(onDisk.equals(payload)).toBe(true);

    await driver.delete(stored.key);

    await expect(fs.access(path.join(uploadDir, stored.key))).rejects.toThrow();
  });

  it('preserves a caller-supplied nested key and writes it under the upload root', async () => {
    const stored = await driver.upload(Buffer.from('avatar'), 'profiles/u1/pic.png', 'image/png');

    expect(stored.key).toBe('profiles/u1/pic.png');
    const onDisk = await fs.readFile(path.join(uploadDir, 'profiles/u1/pic.png'));
    expect(onDisk.toString()).toBe('avatar');
  });

  it('treats deleting an already-missing object as a no-op', async () => {
    await expect(driver.delete('profiles/nobody/never-existed.jpg')).resolves.toBeUndefined();
  });

  it.each([
    ['upload escaping with ../', '../escape.txt'],
    ['upload escaping through a nested key', 'profiles/../../escape.txt'],
    ['upload with an absolute-looking traversal', '/../../escape.txt'],
  ])('rejects %s', async (_label, originalName) => {
    await expect(driver.upload(Buffer.from('x'), originalName, 'image/png')).rejects.toThrow(
      /Refusing to write outside upload directory/,
    );

    const escaped = path.resolve(uploadDir, '..', 'escape.txt');
    await expect(fs.access(escaped)).rejects.toThrow();
  });

  it('rejects deleting a key that resolves outside the upload directory', async () => {
    await expect(driver.delete('../outside.txt')).rejects.toThrow(
      /Refusing to delete outside upload directory/,
    );
  });
});

// ─── S3 driver ─────────────────────────────────────────────────────────────────

describe('S3StorageDriver', () => {
  let send: jest.Mock;
  let driver: S3StorageDriver;

  beforeEach(() => {
    jest.clearAllMocks();
    send = jest.fn().mockResolvedValue({});
    driver = new S3StorageDriver({ send } as unknown as S3Client);
    mockedGetSignedUrl.mockResolvedValue('https://bucket.s3.example/signed?X-Amz-Signature=abc');
  });

  it('uploads the object and returns a signed URL instead of a public one', async () => {
    const stored = await driver.upload(
      Buffer.from('pdf-bytes'),
      'profiles/u2/doc.pdf',
      'application/pdf',
    );

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0][0] as PutObjectCommand;
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toMatchObject({
      Key: 'profiles/u2/doc.pdf',
      ContentType: 'application/pdf',
    });

    expect(mockedGetSignedUrl).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ expiresIn: env.AWS_S3_SIGNED_URL_EXPIRES_SECONDS }),
    );
    expect(stored).toEqual({
      key: 'profiles/u2/doc.pdf',
      url: 'https://bucket.s3.example/signed?X-Amz-Signature=abc',
    });
  });

  it('deletes the object by key', async () => {
    await driver.delete('profiles/u2/doc.pdf');

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBeInstanceOf(DeleteObjectCommand);
    expect(send.mock.calls[0][0].input).toMatchObject({ Key: 'profiles/u2/doc.pdf' });
  });

  it('propagates upload errors from the S3 client', async () => {
    send.mockRejectedValueOnce(new Error('AccessDenied'));

    await expect(driver.upload(Buffer.from('x'), 'a/b.png', 'image/png')).rejects.toThrow(
      'AccessDenied',
    );
    expect(mockedGetSignedUrl).not.toHaveBeenCalled();
  });

  it('propagates delete errors from the S3 client', async () => {
    send.mockRejectedValueOnce(new Error('NetworkingError'));

    await expect(driver.delete('a/b.png')).rejects.toThrow('NetworkingError');
  });
});

// ─── Driver factory ────────────────────────────────────────────────────────────

describe('getStorageDriver', () => {
  const original = env.UPLOAD_STORAGE_DRIVER;

  afterEach(() => {
    Object.assign(env, { UPLOAD_STORAGE_DRIVER: original });
    resetStorageDriverCache();
  });

  it('selects the local driver when UPLOAD_STORAGE_DRIVER is local', () => {
    Object.assign(env, { UPLOAD_STORAGE_DRIVER: 'local' });
    resetStorageDriverCache();

    expect(getStorageDriver()).toBeInstanceOf(LocalStorageDriver);
  });

  it('selects the S3 driver when UPLOAD_STORAGE_DRIVER is s3', () => {
    Object.assign(env, { UPLOAD_STORAGE_DRIVER: 's3' });
    resetStorageDriverCache();

    expect(getStorageDriver()).toBeInstanceOf(S3StorageDriver);
  });

  it('caches the resolved driver until the cache is reset', () => {
    Object.assign(env, { UPLOAD_STORAGE_DRIVER: 'local' });
    resetStorageDriverCache();

    const first = getStorageDriver();
    Object.assign(env, { UPLOAD_STORAGE_DRIVER: 's3' });

    expect(getStorageDriver()).toBe(first);

    resetStorageDriverCache();
    expect(getStorageDriver()).toBeInstanceOf(S3StorageDriver);
  });
});
