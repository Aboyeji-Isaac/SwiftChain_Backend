import { Request, Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { suspendUser } from '../../../src/controllers/adminController';
import { suspendUser as suspendUserService } from '../../../src/services/adminService';
import requireRole from '../../../src/middleware/requireRole';
import AppError from '../../../src/utils/AppError';
import { UserRole } from '../../../src/interfaces/IUser';
import type { IUser } from '../../../src/interfaces/IUser';

jest.mock('../../../src/services/adminService', () => ({
  suspendUser: jest.fn(),
  getAdminDisputes: jest.fn(),
}));

jest.mock('../../../src/config/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

const mockedSuspendService = suspendUserService as jest.MockedFunction<typeof suspendUserService>;

// ─── Helpers ───────────────────────────────────────────────────────────────────

const ADMIN_ID = '64b000000000000000000001';
const TARGET_ID = '64b000000000000000000002';

const adminUser = {
  _id: { toString: () => ADMIN_ID },
  role: UserRole.ADMIN,
} as unknown as IUser;

interface MockResponse {
  res: Response;
  status: jest.Mock;
  json: jest.Mock;
}

const buildResponse = (): MockResponse => {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const res = { status, json } as unknown as Response;
  return { res, status, json };
};

const buildRequest = (body: unknown, user: IUser | null): Request =>
  ({
    params: { id: TARGET_ID },
    body,
    user: user ?? undefined,
  }) as unknown as Request;

const callSuspend = async (
  body: unknown,
  user: IUser | null = adminUser,
): Promise<{ next: jest.Mock; mock: MockResponse }> => {
  const mock = buildResponse();
  const next = jest.fn() as jest.Mock & NextFunction;
  await suspendUser(buildRequest(body, user) as never, mock.res, next);
  return { next, mock };
};

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── suspendUser controller ───────────────────────────────────────────────────

describe('adminController.suspendUser', () => {
  describe('reason enforcement', () => {
    it.each([
      ['missing', {}],
      ['empty string', { reason: '' }],
      ['whitespace only', { reason: '   ' }],
      ['non-string', { reason: 42 }],
    ])('rejects a %s reason with 400 without calling the service', async (_label, body) => {
      const { next } = await callSuspend(body);

      expect(next).toHaveBeenCalledTimes(1);
      const error = next.mock.calls[0][0] as AppError;
      expect(error).toBeInstanceOf(AppError);
      expect(error.statusCode).toBe(StatusCodes.BAD_REQUEST);
      expect(mockedSuspendService).not.toHaveBeenCalled();
    });

    it('trims the reason before passing it to the service', async () => {
      mockedSuspendService.mockResolvedValueOnce({
        user: { _id: TARGET_ID } as unknown as IUser,
        action: 'suspended',
      });

      await callSuspend({ reason: '  Fraud  ' });

      expect(mockedSuspendService).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'Fraud', targetUserId: TARGET_ID, adminId: ADMIN_ID }),
      );
    });
  });

  describe('ban flag validation', () => {
    it.each([['yes'], [1], ['true'], [null]])(
      'rejects a non-boolean ban value (%p) with 400',
      async (ban) => {
        const { next } = await callSuspend({ reason: 'Abuse', ban });

        const error = next.mock.calls[0][0] as AppError;
        expect(error.statusCode).toBe(StatusCodes.BAD_REQUEST);
        expect(error.message).toBe('"ban" must be a boolean value.');
        expect(mockedSuspendService).not.toHaveBeenCalled();
      },
    );

    it('defaults ban to false when omitted', async () => {
      mockedSuspendService.mockResolvedValueOnce({
        user: {} as IUser,
        action: 'suspended',
      });

      await callSuspend({ reason: 'Abuse' });

      expect(mockedSuspendService).toHaveBeenCalledWith(expect.objectContaining({ ban: false }));
    });

    it('passes ban: true through so the service applies a permanent ban', async () => {
      mockedSuspendService.mockResolvedValueOnce({
        user: {} as IUser,
        action: 'banned',
      });

      const { mock } = await callSuspend({ reason: 'Abuse', ban: true });

      expect(mockedSuspendService).toHaveBeenCalledWith(expect.objectContaining({ ban: true }));
      expect(mock.status).toHaveBeenCalledWith(StatusCodes.OK);
      expect(mock.json.mock.calls[0][0].message).toBe('User has been banned successfully.');
    });
  });

  describe('service outcomes', () => {
    it('returns 200 with the updated user on a successful suspension', async () => {
      mockedSuspendService.mockResolvedValueOnce({
        user: { _id: TARGET_ID, status: 'suspended' } as unknown as IUser,
        action: 'suspended',
      });

      const { next, mock } = await callSuspend({ reason: 'Abuse' });

      expect(next).not.toHaveBeenCalled();
      expect(mock.status).toHaveBeenCalledWith(StatusCodes.OK);
      expect(mock.json.mock.calls[0][0].data.user.status).toBe('suspended');
    });

    it('forwards a 409 conflict from the service to the error handler', async () => {
      mockedSuspendService.mockRejectedValueOnce(
        new AppError('User is already suspended.', StatusCodes.CONFLICT),
      );

      const { next } = await callSuspend({ reason: 'Abuse' });

      const error = next.mock.calls[0][0] as AppError;
      expect(error.statusCode).toBe(StatusCodes.CONFLICT);
    });

    it('forwards a 404 for an unknown user from the service', async () => {
      mockedSuspendService.mockRejectedValueOnce(
        new AppError('User not found.', StatusCodes.NOT_FOUND),
      );

      const { next } = await callSuspend({ reason: 'Abuse' });

      const error = next.mock.calls[0][0] as AppError;
      expect(error.statusCode).toBe(StatusCodes.NOT_FOUND);
    });

    it('rejects a request without an authenticated actor with 401', async () => {
      const { next } = await callSuspend({ reason: 'Abuse' }, null);

      const error = next.mock.calls[0][0] as AppError;
      expect(error.statusCode).toBe(StatusCodes.UNAUTHORIZED);
      expect(mockedSuspendService).not.toHaveBeenCalled();
    });
  });
});

// ─── Role gate in front of the controller ─────────────────────────────────────

describe('requireRole(UserRole.ADMIN) in front of suspendUser', () => {
  it('forwards a 403 when the actor is not an admin', () => {
    const next = jest.fn();
    const regularUser = { role: UserRole.USER } as unknown as IUser;
    const req = { user: regularUser } as unknown as Request;

    requireRole(UserRole.ADMIN)(req, {} as Response, next);

    const error = next.mock.calls[0][0] as AppError;
    expect(error.statusCode).toBe(StatusCodes.FORBIDDEN);
  });

  it('lets an admin through to the controller', () => {
    const next = jest.fn();
    const req = { user: adminUser } as unknown as Request;

    requireRole(UserRole.ADMIN)(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith();
  });
});
