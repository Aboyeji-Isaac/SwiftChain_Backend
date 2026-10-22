/**
 * Tests for self-serve merchant onboarding:
 *   POST /api/v1/onboarding/merchant        — register intent, issue challenge
 *   PUT  /api/v1/onboarding/merchant/wallet — prove wallet ownership, activate
 *
 * Requests go through the real Express app and every document lands in an
 * in-memory MongoDB. Wallet proofs are real Ed25519 signatures produced with
 * freshly generated Stellar keypairs, in both the raw and SEP-53 encodings.
 */

import crypto from 'crypto';
import mongoose from 'mongoose';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Keypair } from '@stellar/stellar-sdk';
import app from '../src/app';
import env from '../src/config/env';
import User from '../src/models/User';
import Fleet from '../src/models/Fleet';
import AuditLog from '../src/models/AuditLog';
import Notification from '../src/models/Notification';
import { WebhookSubscription, WebhookEvent } from '../src/models/WebhookSubscription';
import MerchantOnboarding, { OnboardingStatus } from '../src/models/MerchantOnboarding';
import { NotificationEvent } from '../src/models/NotificationPreference';
import { UserRole } from '../src/interfaces/IUser';
import { webhookService } from '../src/services/webhookService';

jest.mock('../src/config/database', () => ({
  connectDatabase: jest.fn(),
}));

jest.mock('../src/config/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

const REGISTER = '/api/v1/onboarding/merchant';
const WALLET = '/api/v1/onboarding/merchant/wallet';
const PASSWORD = 'Sup3rSecret!';

// ─── Fixtures ──────────────────────────────────────────────────────────────────

const registrationBody = (
  treasury: Keypair,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  fleetName: 'Lagos Express',
  treasuryAddress: treasury.publicKey(),
  businessMetadata: {
    companyName: 'Lagos Express Ltd',
    industry: 'logistics',
    registrationNumber: 'RC-123456',
    address: { street: '1 Marina', city: 'Lagos', country: 'ng', postalCode: '101001' },
    contactEmail: 'Ops@LagosExpress.example',
    contactPhone: '+2348000000000',
    website: 'https://lagosexpress.example',
  },
  contact: {
    firstName: 'Ada',
    lastName: 'Obi',
    email: `ada-${crypto.randomBytes(4).toString('hex')}@lagosexpress.example`,
  },
  webhookUrl: 'https://hooks.lagosexpress.example/swiftchain',
  ...overrides,
});

const signRaw = (keypair: Keypair, message: string): string =>
  keypair.sign(Buffer.from(message, 'utf8')).toString('base64');

const signSep53 = (keypair: Keypair, message: string): string => {
  const hash = crypto
    .createHash('sha256')
    .update(Buffer.concat([Buffer.from('Stellar Signed Message:\n'), Buffer.from(message)]))
    .digest();
  return keypair.sign(hash).toString('base64');
};

/** Register an onboarding and return its id, challenge and the body used. */
const register = async (
  treasury: Keypair,
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; message: string; body: Record<string, unknown> }> => {
  const body = registrationBody(treasury, overrides);
  const res = await request(app).post(REGISTER).send(body);
  expect(res.status).toBe(201);
  return { id: res.body.data.onboardingId, message: res.body.data.challenge.message, body };
};

// ─── Lifecycle ──────────────────────────────────────────────────────────────────

let mongoServer: MongoMemoryServer;
const defaultMaxAttempts = env.ONBOARDING_MAX_PROOF_ATTEMPTS;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  // The unique treasuryAddress index is what settles two activations racing for one wallet.
  await Fleet.init();
}, 120_000);

afterEach(async () => {
  env.ONBOARDING_MAX_PROOF_ATTEMPTS = defaultMaxAttempts;
  jest.restoreAllMocks();
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    await collections[key].deleteMany({});
  }
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

// ─── Step 1: register intent ────────────────────────────────────────────────────

describe('POST /api/v1/onboarding/merchant', () => {
  it('stores the intent and returns a challenge naming the onboarding and treasury', async () => {
    const treasury = Keypair.random();
    const before = Date.now();

    const res = await request(app).post(REGISTER).send(registrationBody(treasury));

    expect(res.status).toBe(201);
    const { onboardingId, status, challenge } = res.body.data;
    expect(status).toBe(OnboardingStatus.PENDING_WALLET);
    expect(challenge.message).toContain(`Onboarding: ${onboardingId}`);
    expect(challenge.message).toContain(`Treasury: ${treasury.publicKey()}`);
    expect(challenge.message).toMatch(/Nonce: [a-f0-9]{32}/);
    const expiresAt = new Date(challenge.expiresAt).getTime();
    expect(expiresAt - before).toBeGreaterThanOrEqual(env.ONBOARDING_CHALLENGE_TTL_SECONDS * 1000);

    const stored = await MerchantOnboarding.findById(onboardingId).lean();
    expect(stored?.businessMetadata).toMatchObject({
      companyName: 'Lagos Express Ltd',
      contactEmail: 'ops@lagosexpress.example',
      address: { country: 'NG' },
    });
    // Nothing durable exists until the wallet is proven.
    expect(await User.countDocuments()).toBe(0);
    expect(await Fleet.countDocuments()).toBe(0);
    expect(await WebhookSubscription.countDocuments()).toBe(0);
  });

  it('issues a fresh nonce for every registration', async () => {
    const treasury = Keypair.random();
    const a = await register(treasury);
    const b = await register(treasury);

    expect(a.message).not.toBe(b.message);
  });

  it.each([
    ['an invalid treasury address', { treasuryAddress: 'GNOTAREALKEY' }, 'treasuryAddress'],
    [
      'a secret key as treasury address',
      { treasuryAddress: Keypair.random().secret() },
      'treasuryAddress',
    ],
    ['a missing company name', { businessMetadata: { contactEmail: 'a@b.co' } }, 'companyName'],
    [
      'an invalid contact email',
      { businessMetadata: { companyName: 'Acme', contactEmail: 'nope' } },
      'contactEmail',
    ],
    [
      'a non alpha-2 country',
      {
        businessMetadata: {
          companyName: 'Acme',
          contactEmail: 'a@b.co',
          address: { country: 'Nigeria' },
        },
      },
      'country',
    ],
    ['an invalid webhook URL', { webhookUrl: 'not a url' }, 'webhookUrl'],
    ['a missing owner contact', { contact: undefined }, 'contact'],
  ])('rejects %s with 400', async (_label, overrides, field) => {
    const res = await request(app)
      .post(REGISTER)
      .send(registrationBody(Keypair.random(), overrides));

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain(field);
    expect(await MerchantOnboarding.countDocuments()).toBe(0);
  });

  it('rejects an email that already has an account', async () => {
    const existing = await User.create({
      firstName: 'Taken',
      lastName: 'User',
      email: 'taken@example.com',
      password: PASSWORD,
    });

    const res = await request(app)
      .post(REGISTER)
      .send(
        registrationBody(Keypair.random(), {
          contact: { firstName: 'Ada', lastName: 'Obi', email: existing.email },
        }),
      );

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/email already exists/);
  });

  it('rejects a treasury address already bound to a fleet', async () => {
    const treasury = Keypair.random();
    const owner = await User.create({
      firstName: 'Fleet',
      lastName: 'Owner',
      email: 'owner@example.com',
      password: PASSWORD,
      role: UserRole.ENTERPRISE,
    });
    await Fleet.create({
      name: 'Existing',
      treasuryAddress: treasury.publicKey(),
      ownerId: owner._id,
      businessMetadata: { companyName: 'Existing Co', contactEmail: 'x@example.com' },
    });

    const res = await request(app).post(REGISTER).send(registrationBody(treasury));

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/treasury address/);
  });
});

// ─── Step 2: wallet proof and activation ───────────────────────────────────────

describe('PUT /api/v1/onboarding/merchant/wallet', () => {
  it('activates the merchant: owner, fleet, webhook, notification and audit log', async () => {
    const treasury = Keypair.random();
    const { id, message, body } = await register(treasury);

    const res = await request(app)
      .put(WALLET)
      .send({ onboardingId: id, signature: signRaw(treasury, message), password: PASSWORD });

    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.status).toBe(OnboardingStatus.COMPLETED);

    // Owner: enterprise role, bound wallet, usable credentials and token.
    const contact = body.contact as { email: string };
    const owner = await User.findOne({ email: contact.email }).select('+password');
    expect(owner).not.toBeNull();
    expect(owner!.role).toBe(UserRole.ENTERPRISE);
    expect(owner!.walletAddress).toBe(treasury.publicKey());
    expect(await owner!.comparePassword(PASSWORD)).toBe(true);
    expect(data.user).toMatchObject({ id: String(owner!._id), role: UserRole.ENTERPRISE });
    const decoded = jwt.verify(data.token, env.JWT_SECRET) as { userId: string };
    expect(decoded.userId).toBe(String(owner!._id));

    // Fleet: reuses businessMetadata, owner is its admin member.
    const fleet = await Fleet.findOne({ treasuryAddress: treasury.publicKey() }).lean();
    expect(fleet).toMatchObject({ name: 'Lagos Express', isActive: true });
    expect(String(fleet!.ownerId)).toBe(String(owner!._id));
    expect(fleet!.businessMetadata).toMatchObject({
      companyName: 'Lagos Express Ltd',
      registrationNumber: 'RC-123456',
      contactEmail: 'ops@lagosexpress.example',
    });
    expect(fleet!.members.map((m) => [String(m.userId), m.role])).toEqual([
      [String(owner!._id), 'admin'],
    ]);

    // Webhook: every milestone event, secret returned once and matching storage.
    const webhook = await WebhookSubscription.findOne({ merchantId: owner!._id }).select('+secret');
    expect(webhook).toMatchObject({ url: body.webhookUrl, isActive: true });
    expect([...webhook!.events].sort()).toEqual([...Object.values(WebhookEvent)].sort());
    expect(data.webhook.secret).toBe(webhook!.secret);
    expect(data.webhook.subscription.secret).toBeUndefined();

    // Onboarding-complete notification (recorded even without devices) and audit log.
    const notification = await Notification.findOne({ user: owner!._id }).lean();
    expect(notification).toMatchObject({ event: NotificationEvent.MERCHANT_ONBOARDED });
    expect(notification!.data).toMatchObject({ fleetId: String(fleet!._id) });
    const audit = await AuditLog.findOne({ action: 'merchant.onboarded' }).lean();
    expect(String(audit!.actor)).toBe(String(owner!._id));
    expect(String(audit!.targetId)).toBe(String(fleet!._id));
    expect(audit!.meta).toMatchObject({ onboardingId: id, treasuryAddress: treasury.publicKey() });

    const onboarding = await MerchantOnboarding.findById(id).lean();
    expect(onboarding).toMatchObject({ status: OnboardingStatus.COMPLETED });
    expect(String(onboarding!.fleetId)).toBe(String(fleet!._id));
    expect(String(onboarding!.webhookId)).toBe(String(webhook!._id));
  });

  it('accepts a SEP-53 wallet signature', async () => {
    const treasury = Keypair.random();
    const { id, message } = await register(treasury);

    const res = await request(app)
      .put(WALLET)
      .send({ onboardingId: id, signature: signSep53(treasury, message), password: PASSWORD });

    expect(res.status).toBe(200);
    expect(await Fleet.countDocuments({ treasuryAddress: treasury.publicKey() })).toBe(1);
  });

  it('lets the new owner log in with the chosen password', async () => {
    const treasury = Keypair.random();
    const { id, message, body } = await register(treasury);
    await request(app)
      .put(WALLET)
      .send({ onboardingId: id, signature: signRaw(treasury, message), password: PASSWORD });

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: (body.contact as { email: string }).email, password: PASSWORD });

    expect(login.status).toBe(200);
  });

  describe('wallet-proof rejection', () => {
    it('rejects a signature from a different key and creates nothing', async () => {
      const treasury = Keypair.random();
      const { id, message } = await register(treasury);

      const res = await request(app)
        .put(WALLET)
        .send({
          onboardingId: id,
          signature: signRaw(Keypair.random(), message),
          password: PASSWORD,
        });

      expect(res.status).toBe(401);
      expect(res.body.message).toMatch(/Wallet ownership proof rejected/);
      expect(await User.countDocuments()).toBe(0);
      expect(await Fleet.countDocuments()).toBe(0);
      expect(await WebhookSubscription.countDocuments()).toBe(0);
      const stored = await MerchantOnboarding.findById(id).lean();
      expect(stored).toMatchObject({
        status: OnboardingStatus.PENDING_WALLET,
        failedProofAttempts: 1,
      });
    });

    it('rejects the treasury signing a different message', async () => {
      const treasury = Keypair.random();
      const { id, message } = await register(treasury);
      const tampered = message.replace(/Nonce: [a-f0-9]+/, `Nonce: ${'0'.repeat(32)}`);

      const res = await request(app)
        .put(WALLET)
        .send({ onboardingId: id, signature: signRaw(treasury, tampered), password: PASSWORD });

      expect(res.status).toBe(401);
    });

    it('rejects a signature of the wrong length', async () => {
      const treasury = Keypair.random();
      const { id } = await register(treasury);

      const res = await request(app)
        .put(WALLET)
        .send({
          onboardingId: id,
          signature: Buffer.from('short').toString('base64'),
          password: PASSWORD,
        });

      expect(res.status).toBe(401);
    });

    it('locks the onboarding after too many rejected proofs', async () => {
      env.ONBOARDING_MAX_PROOF_ATTEMPTS = 2;
      const treasury = Keypair.random();
      const { id, message } = await register(treasury);
      const wrong = {
        onboardingId: id,
        signature: signRaw(Keypair.random(), message),
        password: PASSWORD,
      };

      expect((await request(app).put(WALLET).send(wrong)).status).toBe(401);
      expect((await request(app).put(WALLET).send(wrong)).status).toBe(401);
      const locked = await request(app)
        .put(WALLET)
        .send({ onboardingId: id, signature: signRaw(treasury, message), password: PASSWORD });

      expect(locked.status).toBe(429);
      expect(await User.countDocuments()).toBe(0);
    });

    it('rejects an expired challenge with 410', async () => {
      const treasury = Keypair.random();
      const { id, message } = await register(treasury);
      await MerchantOnboarding.updateOne(
        { _id: id },
        { 'challenge.expiresAt': new Date(Date.now() - 1000) },
      );

      const res = await request(app)
        .put(WALLET)
        .send({ onboardingId: id, signature: signRaw(treasury, message), password: PASSWORD });

      expect(res.status).toBe(410);
      expect(await User.countDocuments()).toBe(0);
    });
  });

  describe('validation and state', () => {
    it.each([
      ['a malformed onboarding id', { onboardingId: 'abc' }],
      ['a non-base64 signature', { signature: '***' }],
      ['a short password', { password: 'short' }],
    ])('rejects %s with 400', async (_label, overrides) => {
      const treasury = Keypair.random();
      const { id, message } = await register(treasury);

      const res = await request(app)
        .put(WALLET)
        .send({
          onboardingId: id,
          signature: signRaw(treasury, message),
          password: PASSWORD,
          ...overrides,
        });

      expect(res.status).toBe(400);
    });

    it('returns 404 for an unknown onboarding', async () => {
      const res = await request(app)
        .put(WALLET)
        .send({
          onboardingId: String(new mongoose.Types.ObjectId()),
          signature: signRaw(Keypair.random(), 'x'),
          password: PASSWORD,
        });

      expect(res.status).toBe(404);
    });

    it('refuses to complete an onboarding twice', async () => {
      const treasury = Keypair.random();
      const { id, message } = await register(treasury);
      const proof = { onboardingId: id, signature: signRaw(treasury, message), password: PASSWORD };

      expect((await request(app).put(WALLET).send(proof)).status).toBe(200);
      const again = await request(app).put(WALLET).send(proof);

      expect(again.status).toBe(409);
      expect(await Fleet.countDocuments()).toBe(1);
    });

    it('activates only one of two onboardings racing for the same treasury', async () => {
      const treasury = Keypair.random();
      const first = await register(treasury);
      const second = await register(treasury);

      const [a, b] = await Promise.all([
        request(app)
          .put(WALLET)
          .send({
            onboardingId: first.id,
            signature: signRaw(treasury, first.message),
            password: PASSWORD,
          }),
        request(app)
          .put(WALLET)
          .send({
            onboardingId: second.id,
            signature: signRaw(treasury, second.message),
            password: PASSWORD,
          }),
      ]);

      expect([a.status, b.status].sort()).toEqual([200, 409]);
      expect(await Fleet.countDocuments({ treasuryAddress: treasury.publicKey() })).toBe(1);
    });

    it('rolls back the owner and fleet when the webhook step fails, and allows a retry', async () => {
      const treasury = Keypair.random();
      const { id, message } = await register(treasury);
      const proof = { onboardingId: id, signature: signRaw(treasury, message), password: PASSWORD };
      jest
        .spyOn(webhookService, 'registerWebhook')
        .mockRejectedValueOnce(new Error('webhook store unavailable'));

      const failed = await request(app).put(WALLET).send(proof);

      expect(failed.status).toBe(500);
      expect(await User.countDocuments()).toBe(0);
      expect(await Fleet.countDocuments()).toBe(0);
      expect((await MerchantOnboarding.findById(id).lean())?.status).toBe(
        OnboardingStatus.PENDING_WALLET,
      );

      const retried = await request(app).put(WALLET).send(proof);
      expect(retried.status).toBe(200);
      expect(await Fleet.countDocuments()).toBe(1);
    });
  });
});
