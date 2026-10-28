import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { suspendUser } from '../../../src/services/adminService';
import User from '../../../src/models/User';
import AppError from '../../../src/utils/AppError';
import logger from '../../../src/config/logger';
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

// ─── In-memory MongoDB ─────────────────────────────────────────────────────────

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
}, 120_000);

afterEach(async () => {
  jest.clearAllMocks();
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
  overrides: Partial<{ role: UserRole; status: UserStatus }> = {},
): Promise<InstanceType<typeof User>> =>
  User.create({
    firstName: 'Test',
    lastName: 'User',
    email: `svc-${Date.now()}-${Math.random()}@example.com`,
    password: 'Password123!',
    role: overrides.role ?? UserRole.USER,
    status: overrides.status ?? UserStatus.ACTIVE,
  });

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

// ─── suspendUser service ──────────────────────────────────────────────────────

describe('adminService.suspendUser', () => {
  it('suspends an active user and records the reason and timestamp', async () => {
    const admin = await createUser({ role: UserRole.ADMIN });
    const target = await createUser();

    const result = await suspendUser({
      targetUserId: target._id.toString(),
      adminId: admin._id.toString(),
      reason: 'Repeated no-shows',
    });

    expect(result.action).toBe('suspended');
    expect(result.user.status).toBe(UserStatus.SUSPENDED);

    const reloaded = await User.findById(target._id);
    expect(reloaded?.status).toBe(UserStatus.SUSPENDED);
    expect(reloaded?.suspendedReason).toBe('Repeated no-shows');
    expect(reloaded?.suspendedAt).toBeInstanceOf(Date);
  });

  it('applies a permanent ban immediately when ban is true', async () => {
    const admin = await createUser({ role: UserRole.ADMIN });
    const target = await createUser();

    const result = await suspendUser({
      targetUserId: target._id.toString(),
      adminId: admin._id.toString(),
      reason: 'Fraud',
      ban: true,
    });

    expect(result.action).toBe('banned');
    const reloaded = await User.findById(target._id);
    expect(reloaded?.status).toBe(UserStatus.BANNED);
  });

  it('returns 409 when the user is already suspended', async () => {
    const admin = await createUser({ role: UserRole.ADMIN });
    const target = await createUser({ status: UserStatus.SUSPENDED });

    await expectAppError(
      suspendUser({
        targetUserId: target._id.toString(),
        adminId: admin._id.toString(),
        reason: 'Again',
      }),
      409,
    );
  });

  it('returns 409 when a banned user is requested to be banned again', async () => {
    const admin = await createUser({ role: UserRole.ADMIN });
    const target = await createUser({ status: UserStatus.BANNED });

    await expectAppError(
      suspendUser({
        targetUserId: target._id.toString(),
        adminId: admin._id.toString(),
        reason: 'Again',
        ban: true,
      }),
      409,
    );
  });

  it('returns 404 for a well-formed id that does not exist', async () => {
    const admin = await createUser({ role: UserRole.ADMIN });

    await expectAppError(
      suspendUser({
        targetUserId: new mongoose.Types.ObjectId().toString(),
        adminId: admin._id.toString(),
        reason: 'Missing',
      }),
      404,
    );
  });

  it('returns 400 for a malformed user id', async () => {
    const admin = await createUser({ role: UserRole.ADMIN });

    await expectAppError(
      suspendUser({
        targetUserId: 'not-an-object-id',
        adminId: admin._id.toString(),
        reason: 'Bad id',
      }),
      400,
    );
  });

  it('returns 422 when an admin targets their own account', async () => {
    const admin = await createUser({ role: UserRole.ADMIN });

    await expectAppError(
      suspendUser({
        targetUserId: admin._id.toString(),
        adminId: admin._id.toString(),
        reason: 'Self',
      }),
      422,
    );
  });

  it('returns 403 when an admin targets another admin', async () => {
    const admin = await createUser({ role: UserRole.ADMIN });
    const otherAdmin = await createUser({ role: UserRole.ADMIN });

    await expectAppError(
      suspendUser({
        targetUserId: otherAdmin._id.toString(),
        adminId: admin._id.toString(),
        reason: 'Escalation',
      }),
      403,
    );

    const reloaded = await User.findById(otherAdmin._id);
    expect(reloaded?.status).toBe(UserStatus.ACTIVE);
  });

  it('writes an audit log entry with the acting admin and the reason', async () => {
    const admin = await createUser({ role: UserRole.ADMIN });
    const target = await createUser();

    await suspendUser({
      targetUserId: target._id.toString(),
      adminId: admin._id.toString(),
      reason: 'Audit me',
    });

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining(
        `Admin ${admin._id.toString()} suspended user ${target._id.toString()}`,
      ),
    );
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Reason: "Audit me"'));
  });
});
