/**
 * Unit tests for the timeout and observability additions to the RPC retry
 * helper, and for the transient-error classifier used by StellarService.
 */

import {
  withRetry,
  withTimeout,
  OperationTimeoutError,
  type AttemptFailureKind,
} from '../src/utils/rpcRetry';
import { isTransientRpcError } from '../src/services/stellarService';

jest.mock('../src/config/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    http: jest.fn(),
  },
}));

/** Resolve after `ms`, used to simulate a slow call. */
const slow = <T>(value: T, ms: number): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms));

describe('withTimeout', () => {
  it('resolves when the operation finishes inside the budget', async () => {
    await expect(withTimeout(() => slow('ok', 5), 200, 'fast')).resolves.toBe('ok');
  });

  it('rejects with OperationTimeoutError when the budget is exceeded', async () => {
    await expect(withTimeout(() => slow('late', 200), 20, 'slow')).rejects.toBeInstanceOf(
      OperationTimeoutError,
    );
  });

  it('names the operation and the budget in the timeout message', async () => {
    await expect(withTimeout(() => slow('late', 200), 20, 'getAccount')).rejects.toThrow(
      /getAccount.*20ms/,
    );
  });

  it('does not apply a timeout when the budget is zero', async () => {
    await expect(withTimeout(() => slow('ok', 30), 0, 'untimed')).resolves.toBe('ok');
  });

  it('propagates the underlying rejection rather than a timeout', async () => {
    await expect(withTimeout(() => Promise.reject(new Error('boom')), 500, 'op')).rejects.toThrow(
      'boom',
    );
  });
});

describe('withRetry timeout handling', () => {
  it('retries a timed-out attempt and succeeds once the call is fast enough', async () => {
    let call = 0;
    const fn = jest.fn(() => {
      call += 1;
      return call === 1 ? slow('late', 200) : slow('ok', 1);
    });

    const result = await withRetry(fn, {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 2,
      jitter: 0,
      timeoutMs: 30,
      operationName: 'flaky',
    });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('reports the failure kind as timeout to the retry predicate', async () => {
    const kinds: AttemptFailureKind[] = [];

    await expect(
      withRetry(() => slow('late', 200), {
        maxAttempts: 2,
        baseDelayMs: 1,
        maxDelayMs: 2,
        jitter: 0,
        timeoutMs: 20,
        operationName: 'always-slow',
        isRetryable: (_error, kind) => {
          kinds.push(kind);
          return true;
        },
      }),
    ).rejects.toBeInstanceOf(OperationTimeoutError);

    expect(kinds).toEqual(['timeout', 'timeout']);
  });

  it('invokes onAttemptFailed for each failure, with no delay on the last', async () => {
    const contexts: Array<{ attempt: number; delayMs: number }> = [];

    await expect(
      withRetry(() => Promise.reject(new Error('nope')), {
        maxAttempts: 3,
        baseDelayMs: 1,
        maxDelayMs: 2,
        jitter: 0,
        operationName: 'failing',
        onAttemptFailed: ({ attempt, delayMs }) => contexts.push({ attempt, delayMs }),
      }),
    ).rejects.toThrow('nope');

    expect(contexts.map((c) => c.attempt)).toEqual([1, 2, 3]);
    expect(contexts[2].delayMs).toBe(0);
  });

  it('invokes onRecovery only when a retry eventually succeeds', async () => {
    const onRecovery = jest.fn();

    await withRetry(jest.fn().mockRejectedValueOnce(new Error('blip')).mockResolvedValue('ok'), {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 2,
      jitter: 0,
      operationName: 'recovers',
      onRecovery,
    });

    expect(onRecovery).toHaveBeenCalledTimes(1);
    expect(onRecovery.mock.calls[0][0].attempt).toBe(2);
  });

  it('does not invoke onRecovery when the first attempt succeeds', async () => {
    const onRecovery = jest.fn();

    await withRetry(() => Promise.resolve('ok'), {
      maxAttempts: 3,
      baseDelayMs: 1,
      operationName: 'clean',
      onRecovery,
    });

    expect(onRecovery).not.toHaveBeenCalled();
  });

  it('stops immediately when the predicate rejects the error as permanent', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('bad request'));

    await expect(
      withRetry(fn, {
        maxAttempts: 5,
        baseDelayMs: 1,
        operationName: 'permanent',
        isRetryable: () => false,
      }),
    ).rejects.toThrow('bad request');

    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('isTransientRpcError', () => {
  it('treats a timeout as transient', () => {
    expect(isTransientRpcError(new OperationTimeoutError('op', 10))).toBe(true);
    expect(isTransientRpcError(new Error('anything'), 'timeout')).toBe(true);
  });

  it.each([408, 425, 429, 500, 502, 503, 504])('retries HTTP %i', (status) => {
    expect(isTransientRpcError({ status })).toBe(true);
  });

  it.each([400, 401, 403, 404, 422])('does not retry HTTP %i', (status) => {
    expect(isTransientRpcError({ status })).toBe(false);
  });

  it.each(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'])(
    'retries socket error %s',
    (code) => {
      expect(isTransientRpcError({ code })).toBe(true);
    },
  );

  it('reads the status from a nested response object', () => {
    expect(isTransientRpcError({ response: { status: 503 } })).toBe(true);
    expect(isTransientRpcError({ response: { status: 400 } })).toBe(false);
  });

  it('never retries tx_bad_seq, which has its own rebuild path', () => {
    expect(isTransientRpcError(new Error('transaction failed: tx_bad_seq'))).toBe(false);
    expect(isTransientRpcError(new Error('txBadSeq'))).toBe(false);
  });

  it('recognises transient failures described only in the message', () => {
    expect(isTransientRpcError(new Error('socket hang up'))).toBe(true);
    expect(isTransientRpcError(new Error('Request timed out'))).toBe(true);
    expect(isTransientRpcError(new Error('503 Service Unavailable'))).toBe(true);
  });

  it('does not retry a deterministic error', () => {
    expect(isTransientRpcError(new Error('invalid contract id'))).toBe(false);
  });
});
