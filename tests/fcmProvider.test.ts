/**
 * Unit tests for FcmProvider.
 *
 * FCM is an external HTTP service, so axios is mocked here — but everything on
 * our side of the boundary is real: the RS256 service-account JWT is genuinely
 * signed with a generated key pair and verified in-test, and the error
 * classification, token caching and fan-out logic run unmodified.
 */

import crypto from 'crypto';
import axios from 'axios';
import { FcmProvider } from '../src/services/push/fcmProvider';

jest.mock('axios');
jest.mock('../src/config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;

/** A real RSA key pair, so JWT signatures can be verified rather than assumed. */
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const PROJECT_ID = 'test-project';
const CLIENT_EMAIL = 'svc@test-project.iam.gserviceaccount.com';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Build a provider wired to the generated key pair. */
const createProvider = (key: string = privateKey): FcmProvider =>
  new FcmProvider(PROJECT_ID, CLIENT_EMAIL, key);

/** Shape an axios error the way the FCM v1 API reports a per-token failure. */
const fcmError = (errorCode: string, status = 'INVALID_ARGUMENT'): unknown => {
  const error = new Error('Request failed') as Error & {
    isAxiosError: boolean;
    response: { data: unknown };
  };
  error.isAxiosError = true;
  error.response = {
    data: { error: { status, details: [{ errorCode }] } },
  };
  return error;
};

/** Route token-endpoint calls to an access token and sends to `sendImpl`. */
const stubTransport = (sendImpl: () => Promise<unknown>): void => {
  mockedAxios.post.mockImplementation(async (url: string) => {
    if (url === TOKEN_URL) {
      return { data: { access_token: 'access-token-abc', expires_in: 3600 } };
    }
    return sendImpl();
  });
};

describe('FcmProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // isAxiosError is a real function on the module; the mock must keep it.
    (mockedAxios.isAxiosError as unknown as jest.Mock) = jest.fn(
      (error: { isAxiosError?: boolean }) => Boolean(error?.isAxiosError),
    );
  });

  // ── Configuration ─────────────────────────────────────────────────────────

  describe('isConfigured', () => {
    it('is configured when all three credentials are present', () => {
      expect(createProvider().isConfigured()).toBe(true);
    });

    it.each([
      ['project id', ['', CLIENT_EMAIL, privateKey]],
      ['client email', [PROJECT_ID, '', privateKey]],
      ['private key', [PROJECT_ID, CLIENT_EMAIL, '']],
    ])('is not configured without a %s', (_label, args) => {
      const [project, email, key] = args as [string, string, string];
      expect(new FcmProvider(project, email, key).isConfigured()).toBe(false);
    });

    it('reports a failure rather than sending when unconfigured', async () => {
      const provider = new FcmProvider('', '', '');
      const result = await provider.send({
        tokens: ['t1', 't2'],
        title: 'T',
        body: 'B',
        data: {},
      });

      expect(result.acceptedCount).toBe(0);
      expect(result.rejectedCount).toBe(2);
      expect(result.failureReason).toMatch(/not configured/i);
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });
  });

  // ── Sending ───────────────────────────────────────────────────────────────

  describe('send', () => {
    it('returns immediately when there are no target tokens', async () => {
      const result = await createProvider().send({
        tokens: [],
        title: 'T',
        body: 'B',
        data: {},
      });

      expect(result).toEqual({ acceptedCount: 0, rejectedCount: 0, invalidTokens: [] });
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('sends one request per token and counts acceptances', async () => {
      stubTransport(async () => ({ data: { name: 'projects/test/messages/1' } }));

      const result = await createProvider().send({
        tokens: ['t1', 't2', 't3'],
        title: 'T',
        body: 'B',
        data: {},
      });

      expect(result.acceptedCount).toBe(3);
      expect(result.rejectedCount).toBe(0);
      // One token exchange plus one send per token.
      expect(mockedAxios.post).toHaveBeenCalledTimes(4);
    });

    it('posts to the project-scoped v1 send endpoint', async () => {
      stubTransport(async () => ({ data: {} }));

      await createProvider().send({ tokens: ['t1'], title: 'T', body: 'B', data: {} });

      const sendCall = mockedAxios.post.mock.calls.find(([url]) => url !== TOKEN_URL);
      expect(sendCall?.[0]).toBe(
        `https://fcm.googleapis.com/v1/projects/${PROJECT_ID}/messages:send`,
      );
    });

    it('sends the notification and data payload in the v1 message shape', async () => {
      stubTransport(async () => ({ data: {} }));

      await createProvider().send({
        tokens: ['t1'],
        title: 'Delivery completed',
        body: 'Your parcel arrived',
        data: { deliveryId: 'abc', status: 'completed' },
      });

      const sendCall = mockedAxios.post.mock.calls.find(([url]) => url !== TOKEN_URL);
      expect(sendCall?.[1]).toEqual({
        message: {
          token: 't1',
          notification: { title: 'Delivery completed', body: 'Your parcel arrived' },
          data: { deliveryId: 'abc', status: 'completed' },
        },
      });
    });

    it('authorises the send with the access token from the token endpoint', async () => {
      stubTransport(async () => ({ data: {} }));

      await createProvider().send({ tokens: ['t1'], title: 'T', body: 'B', data: {} });

      const sendCall = mockedAxios.post.mock.calls.find(([url]) => url !== TOKEN_URL);
      const config = sendCall?.[2] as { headers: Record<string, string> };
      expect(config.headers.Authorization).toBe('Bearer access-token-abc');
    });

    it('isolates a single token failure from the rest of the batch', async () => {
      let call = 0;
      stubTransport(async () => {
        call += 1;
        if (call === 2) throw fcmError('INTERNAL');
        return { data: {} };
      });

      const result = await createProvider().send({
        tokens: ['t1', 't2', 't3'],
        title: 'T',
        body: 'B',
        data: {},
      });

      expect(result.acceptedCount).toBe(2);
      expect(result.rejectedCount).toBe(1);
    });
  });

  // ── Token classification ──────────────────────────────────────────────────

  describe('invalid token classification', () => {
    it.each(['UNREGISTERED', 'INVALID_ARGUMENT', 'SENDER_ID_MISMATCH'])(
      'marks %s as a permanently invalid token',
      async (errorCode) => {
        stubTransport(async () => {
          throw fcmError(errorCode);
        });

        const result = await createProvider().send({
          tokens: ['dead-token'],
          title: 'T',
          body: 'B',
          data: {},
        });

        expect(result.invalidTokens).toEqual(['dead-token']);
      },
    );

    it.each(['INTERNAL', 'UNAVAILABLE', 'QUOTA_EXCEEDED'])(
      'does not prune a token after a transient %s failure',
      async (errorCode) => {
        stubTransport(async () => {
          throw fcmError(errorCode, errorCode);
        });

        const result = await createProvider().send({
          tokens: ['good-token'],
          title: 'T',
          body: 'B',
          data: {},
        });

        // A retryable failure must not cost the user their registration.
        expect(result.invalidTokens).toEqual([]);
        expect(result.rejectedCount).toBe(1);
      },
    );

    it('does not prune a token on an unclassifiable failure', async () => {
      stubTransport(async () => {
        throw new Error('socket hang up');
      });

      const result = await createProvider().send({
        tokens: ['good-token'],
        title: 'T',
        body: 'B',
        data: {},
      });

      expect(result.invalidTokens).toEqual([]);
    });
  });

  // ── Authentication ────────────────────────────────────────────────────────

  describe('service-account authentication', () => {
    /** Split a JWT and decode its header and claims. */
    const decodeJwt = (jwt: string) => {
      const [header, claims, signature] = jwt.split('.');
      return {
        header: JSON.parse(Buffer.from(header, 'base64url').toString()),
        claims: JSON.parse(Buffer.from(claims, 'base64url').toString()),
        signingInput: `${header}.${claims}`,
        signature,
      };
    };

    /** Perform one send and return the JWT presented to the token endpoint. */
    const captureAssertion = async (): Promise<string> => {
      stubTransport(async () => ({ data: {} }));
      await createProvider().send({ tokens: ['t1'], title: 'T', body: 'B', data: {} });

      const tokenCall = mockedAxios.post.mock.calls.find(([url]) => url === TOKEN_URL);
      return new URLSearchParams(tokenCall?.[1] as string).get('assertion') as string;
    };

    it('signs the assertion with the service-account private key', async () => {
      const { signingInput, signature } = decodeJwt(await captureAssertion());

      const verified = crypto
        .createVerify('RSA-SHA256')
        .update(signingInput)
        .verify(publicKey, Buffer.from(signature, 'base64url'));

      expect(verified).toBe(true);
    });

    it('declares RS256 in the JWT header', async () => {
      expect(decodeJwt(await captureAssertion()).header).toEqual({ alg: 'RS256', typ: 'JWT' });
    });

    it('requests the firebase.messaging scope for the service account', async () => {
      const { claims } = decodeJwt(await captureAssertion());

      expect(claims.iss).toBe(CLIENT_EMAIL);
      expect(claims.aud).toBe(TOKEN_URL);
      expect(claims.scope).toBe('https://www.googleapis.com/auth/firebase.messaging');
    });

    it('issues a JWT that expires within an hour', async () => {
      const { claims } = decodeJwt(await captureAssertion());
      expect(claims.exp - claims.iat).toBe(3600);
    });

    it('normalises escaped newlines in a key read from the environment', async () => {
      // .env files carry PEM keys with literal \n sequences rather than real
      // newlines; without normalisation the key would fail to parse.
      const escaped = privateKey.replace(/\n/g, '\\n');
      stubTransport(async () => ({ data: {} }));

      const result = await createProvider(escaped).send({
        tokens: ['t1'],
        title: 'T',
        body: 'B',
        data: {},
      });

      expect(result.acceptedCount).toBe(1);
    });

    it('reuses a cached access token across sends', async () => {
      stubTransport(async () => ({ data: {} }));
      const provider = createProvider();

      await provider.send({ tokens: ['t1'], title: 'T', body: 'B', data: {} });
      await provider.send({ tokens: ['t2'], title: 'T', body: 'B', data: {} });

      const tokenCalls = mockedAxios.post.mock.calls.filter(([url]) => url === TOKEN_URL);
      expect(tokenCalls).toHaveLength(1);
    });

    it('fetches the access token once for concurrent sends', async () => {
      stubTransport(async () => ({ data: {} }));
      const provider = createProvider();

      await Promise.all([
        provider.send({ tokens: ['t1'], title: 'T', body: 'B', data: {} }),
        provider.send({ tokens: ['t2'], title: 'T', body: 'B', data: {} }),
        provider.send({ tokens: ['t3'], title: 'T', body: 'B', data: {} }),
      ]);

      const tokenCalls = mockedAxios.post.mock.calls.filter(([url]) => url === TOKEN_URL);
      expect(tokenCalls).toHaveLength(1);
    });

    it('reports an authentication failure without throwing', async () => {
      mockedAxios.post.mockImplementation(async (url: string) => {
        if (url === TOKEN_URL) throw new Error('invalid_grant');
        return { data: {} };
      });

      const result = await createProvider().send({
        tokens: ['t1', 't2'],
        title: 'T',
        body: 'B',
        data: {},
      });

      expect(result.acceptedCount).toBe(0);
      expect(result.rejectedCount).toBe(2);
      expect(result.failureReason).toMatch(/authentication failed/i);
      // The tokens are still valid; only the credentials failed.
      expect(result.invalidTokens).toEqual([]);
    });

    it('does not send when authentication fails', async () => {
      mockedAxios.post.mockImplementation(async (url: string) => {
        if (url === TOKEN_URL) throw new Error('invalid_grant');
        return { data: {} };
      });

      await createProvider().send({ tokens: ['t1'], title: 'T', body: 'B', data: {} });

      const sendCalls = mockedAxios.post.mock.calls.filter(([url]) => url !== TOKEN_URL);
      expect(sendCalls).toHaveLength(0);
    });
  });
});
