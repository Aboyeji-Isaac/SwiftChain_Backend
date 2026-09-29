import crypto from 'crypto';
import axios, { AxiosError } from 'axios';
import logger from '../../config/logger';
import env from '../../config/env';
import { IPushProvider, PushMessage, PushResult } from './pushProvider';

/** Google OAuth2 token endpoint used to exchange a signed JWT for an access token. */
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** Scope required to call the FCM HTTP v1 send endpoint. */
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
/** Refresh the access token this many seconds before it actually expires. */
const TOKEN_REFRESH_SKEW_SECONDS = 60;

/**
 * FCM error codes that mean the token will never be valid again.
 *
 * Anything else (quota, transient server errors) leaves the token in place so
 * a later send can retry it.
 */
const PERMANENT_TOKEN_ERRORS = new Set(['UNREGISTERED', 'INVALID_ARGUMENT', 'SENDER_ID_MISMATCH']);

interface CachedAccessToken {
  token: string;
  /** Epoch milliseconds after which the token must be refreshed. */
  expiresAt: number;
}

/**
 * Firebase Cloud Messaging transport, built on the HTTP v1 API.
 *
 * Authentication follows the service-account flow: a JWT signed with the
 * service account's private key is exchanged for a short-lived OAuth2 access
 * token, which is cached until shortly before it expires.
 *
 * FCM v1 sends to one token per request, so a multi-device send fans out and
 * the per-token outcomes are aggregated. Failures are isolated per token — one
 * uninstalled device does not fail the whole notification.
 */
export class FcmProvider implements IPushProvider {
  public readonly name = 'fcm';

  private cachedToken: CachedAccessToken | null = null;
  /** In-flight token request, shared so concurrent sends fetch once. */
  private pendingToken: Promise<string> | null = null;

  constructor(
    private readonly projectId: string = env.FCM_PROJECT_ID,
    private readonly clientEmail: string = env.FCM_CLIENT_EMAIL,
    private readonly privateKey: string = env.FCM_PRIVATE_KEY,
  ) {}

  /**
   * True only when all three service-account fields are present.
   *
   * Credentials are optional in development and test, so the service must be
   * able to ask before it tries to send.
   */
  isConfigured(): boolean {
    return Boolean(this.projectId && this.clientEmail && this.privateKey);
  }

  async send(message: PushMessage): Promise<PushResult> {
    if (!this.isConfigured()) {
      return {
        acceptedCount: 0,
        rejectedCount: message.tokens.length,
        invalidTokens: [],
        failureReason: 'FCM credentials are not configured',
      };
    }

    if (message.tokens.length === 0) {
      return { acceptedCount: 0, rejectedCount: 0, invalidTokens: [] };
    }

    let accessToken: string;
    try {
      accessToken = await this.getAccessToken();
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`[FcmProvider] Failed to obtain access token: ${reason}`);
      return {
        acceptedCount: 0,
        rejectedCount: message.tokens.length,
        invalidTokens: [],
        failureReason: `FCM authentication failed: ${reason}`,
      };
    }

    const endpoint = `https://fcm.googleapis.com/v1/projects/${this.projectId}/messages:send`;

    const outcomes = await Promise.all(
      message.tokens.map((token) => this.sendToToken(endpoint, accessToken, token, message)),
    );

    const invalidTokens = outcomes
      .filter((outcome) => outcome.permanentFailure)
      .map((outcome) => outcome.token);

    const acceptedCount = outcomes.filter((outcome) => outcome.accepted).length;

    return {
      acceptedCount,
      rejectedCount: outcomes.length - acceptedCount,
      invalidTokens,
    };
  }

  /** Send to a single token, classifying any failure as permanent or transient. */
  private async sendToToken(
    endpoint: string,
    accessToken: string,
    token: string,
    message: PushMessage,
  ): Promise<{ token: string; accepted: boolean; permanentFailure: boolean }> {
    try {
      await axios.post(
        endpoint,
        {
          message: {
            token,
            notification: { title: message.title, body: message.body },
            data: message.data,
          },
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          timeout: env.FCM_REQUEST_TIMEOUT_MS,
        },
      );

      return { token, accepted: true, permanentFailure: false };
    } catch (error) {
      const errorCode = this.extractErrorCode(error);
      const permanentFailure = errorCode !== undefined && PERMANENT_TOKEN_ERRORS.has(errorCode);

      logger.warn(
        `[FcmProvider] Send rejected — code=${errorCode ?? 'unknown'} ` +
          `permanent=${permanentFailure} token=${this.maskToken(token)}`,
      );

      return { token, accepted: false, permanentFailure };
    }
  }

  /**
   * Pull FCM's machine-readable error code out of an error response.
   *
   * The v1 API nests it under `error.details[].errorCode`, falling back to the
   * top-level `error.status` for transport-level failures.
   */
  private extractErrorCode(error: unknown): string | undefined {
    if (!axios.isAxiosError(error)) return undefined;

    const data = (
      error as AxiosError<{
        error?: {
          status?: string;
          details?: Array<{ errorCode?: string }>;
        };
      }>
    ).response?.data;

    const detailCode = data?.error?.details?.find((detail) => detail.errorCode)?.errorCode;
    return detailCode ?? data?.error?.status;
  }

  /** Truncate a registration token so logs never carry a usable credential. */
  private maskToken(token: string): string {
    return token.length <= 12 ? '***' : `${token.slice(0, 6)}...${token.slice(-4)}`;
  }

  /**
   * Return a valid OAuth2 access token, minting one if the cache is cold.
   *
   * Concurrent callers share a single in-flight request rather than each
   * hitting Google's token endpoint.
   */
  private async getAccessToken(): Promise<string> {
    if (this.cachedToken && Date.now() < this.cachedToken.expiresAt) {
      return this.cachedToken.token;
    }

    if (this.pendingToken) return this.pendingToken;

    this.pendingToken = this.requestAccessToken().finally(() => {
      this.pendingToken = null;
    });

    return this.pendingToken;
  }

  /** Exchange a signed service-account JWT for an OAuth2 access token. */
  private async requestAccessToken(): Promise<string> {
    const assertion = this.buildSignedJwt();

    const response = await axios.post<{ access_token: string; expires_in: number }>(
      GOOGLE_TOKEN_URL,
      new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: env.FCM_REQUEST_TIMEOUT_MS,
      },
    );

    const { access_token: token, expires_in: expiresIn } = response.data;

    this.cachedToken = {
      token,
      expiresAt: Date.now() + (expiresIn - TOKEN_REFRESH_SKEW_SECONDS) * 1000,
    };

    return token;
  }

  /**
   * Build the RS256-signed JWT that authenticates the service account.
   *
   * Private keys stored in `.env` carry literal `\n` sequences rather than real
   * newlines, so they are normalised before PEM parsing.
   */
  private buildSignedJwt(): string {
    const issuedAt = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const claims = {
      iss: this.clientEmail,
      scope: FCM_SCOPE,
      aud: GOOGLE_TOKEN_URL,
      iat: issuedAt,
      exp: issuedAt + 3600,
    };

    const encode = (value: object): string =>
      Buffer.from(JSON.stringify(value)).toString('base64url');

    const signingInput = `${encode(header)}.${encode(claims)}`;
    const signature = crypto
      .createSign('RSA-SHA256')
      .update(signingInput)
      .sign(this.privateKey.replace(/\\n/g, '\n'), 'base64url');

    return `${signingInput}.${signature}`;
  }
}

export const fcmProvider = new FcmProvider();
