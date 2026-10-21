/**
 * Tests for EventLog retry tracking: the first retry the poller schedules on a
 * handler failure, the retry lifecycle in EventLogRetryService, the admin
 * endpoints, and DLQ escalation.
 *
 * EventLog, DlqEntry, AuditLog and User are real models on an in-memory
 * MongoDB. Retries replay through a real EventPoller — the same topic →
 * subscription → handler dispatch path the poller uses — backed by a fake
 * Soroban RPC node that serves a fixed event list, which keeps the suite off
 * the network.
 */

import mongoose, { Types } from 'mongoose';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { rpc as StellarRpc, xdr } from '@stellar/stellar-sdk';
import app from '../src/app';
import env from '../src/config/env';
import EventLog, { IEventLog } from '../src/models/EventLog';
import { IndexerStatus } from '../src/models/IndexerStatus';
import { DlqEntry, DlqStatus } from '../src/models/DlqEntry';
import AuditLog from '../src/models/AuditLog';
import User from '../src/models/User';
import { UserRole, UserStatus } from '../src/interfaces/IUser';
import * as eventPollerModule from '../src/services/eventPoller';
import { EventPoller } from '../src/services/eventPoller';
import { EventLogRetryService } from '../src/services/eventLogRetryService';
import { eventLogRetryDelayMs } from '../src/utils/eventLogBackoff';
import type {
  ISorobanRpcClient,
  SorobanGetEventsRequest,
} from '../src/services/providers/sorobanRpcClient';

jest.mock('../src/config/database', () => ({
  connectDatabase: jest.fn(),
}));

jest.mock('../src/config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const NETWORK = 'testnet';
const CONTRACT_ID = 'CTESTESCROWCONTRACT';
const FUNDED_TOPIC = 'escrow_funded';
const JWT_SECRET = 'test-secret-key-16chars';
const HOUR_MS = 60 * 60 * 1000;

// ─── Fixtures ──────────────────────────────────────────────────────────────────

const buildEvent = (ledger: number, topic = FUNDED_TOPIC): StellarRpc.Api.EventResponse => {
  const id = `event-${ledger}`;
  return {
    id,
    type: 'contract',
    ledger,
    ledgerClosedAt: '2026-10-21T00:00:00Z',
    contractId: CONTRACT_ID,
    txHash: `tx-${id}`,
    topic: [xdr.ScVal.scvSymbol(topic)],
    value: xdr.ScVal.scvVoid(),
    inSuccessfulContractCall: true,
    pagingToken: id,
  } as unknown as StellarRpc.Api.EventResponse;
};

/** Fake RPC node paging through `events` from the requested start ledger. */
const createFakeRpc = (latestLedger: number, events: StellarRpc.Api.EventResponse[]) => {
  const getEvents = jest.fn(async (req: SorobanGetEventsRequest) => {
    const limit = req.limit ?? 100;
    const firstInWindow = events.findIndex((event) => event.ledger >= (req.startLedger ?? 0));
    const start =
      req.cursor !== undefined
        ? Number(req.cursor)
        : firstInWindow === -1
          ? events.length
          : firstInWindow;
    const page = events.slice(start, start + limit);
    return { latestLedger, events: page, cursor: String(start + page.length) };
  });
  return {
    rpc: {
      getLatestLedger: jest.fn(async () => ({ sequence: latestLedger })),
      getEvents,
    } as unknown as ISorobanRpcClient,
    getEvents,
  };
};

const createPoller = (rpc: ISorobanRpcClient, handle: jest.Mock): EventPoller =>
  new EventPoller({
    rpc,
    network: NETWORK,
    contractId: CONTRACT_ID,
    subscriptions: [{ eventType: 'escrow', topic: FUNDED_TOPIC, handle }],
    intervalMs: 60_000,
    pageSize: 100,
  });

/**
 * Ingest `event` through a poller whose handler fails, leaving a real
 * `failed` EventLog entry exactly as production does.
 */
const ingestFailingEvent = async (
  event: StellarRpc.Api.EventResponse,
  rpc: ISorobanRpcClient,
  message = 'settlement rejected',
): Promise<IEventLog> => {
  await IndexerStatus.updateOne(
    { network: NETWORK },
    { $set: { lastProcessedLedger: event.ledger - 1, lastProcessedAt: new Date() } },
    { upsert: true },
  );
  const failing = jest.fn().mockRejectedValue(new Error(message));
  await createPoller(rpc, failing).pollOnce();
  const entry = await EventLog.findOne({ transactionHash: event.txHash });
  if (!entry) throw new Error('event was not recorded');
  return entry;
};

/** A moment safely past any backoff the tests schedule. */
const farFuture = (): Date => new Date(Date.now() + 48 * HOUR_MS);

const createUser = (role: UserRole) =>
  User.create({
    firstName: 'Test',
    lastName: role,
    email: `${role}-${Date.now()}-${Math.random()}@example.com`,
    password: 'Password123!',
    role,
    status: UserStatus.ACTIVE,
  });

const tokenFor = (userId: unknown): string =>
  jwt.sign({ userId: String(userId) }, JWT_SECRET, { expiresIn: '1h' });

// ─── Lifecycle ──────────────────────────────────────────────────────────────────

let mongoServer: MongoMemoryServer;
const defaultMaxAttempts = env.EVENTLOG_RETRY_MAX_ATTEMPTS;
const defaultBatchSize = env.EVENTLOG_RETRY_BATCH_SIZE;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await Promise.all([EventLog.init(), IndexerStatus.init()]);
}, 120_000);

afterEach(async () => {
  env.EVENTLOG_RETRY_MAX_ATTEMPTS = defaultMaxAttempts;
  env.EVENTLOG_RETRY_BATCH_SIZE = defaultBatchSize;
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

// ─── Poller: first retry ────────────────────────────────────────────────────────

describe('EventPoller — handler failure schedules the first retry', () => {
  it('records retry metadata alongside the failed status', async () => {
    const event = buildEvent(101);
    const { rpc } = createFakeRpc(101, [event]);
    const before = Date.now();

    const entry = await ingestFailingEvent(event, rpc);

    expect(entry).toMatchObject({
      status: 'failed',
      errorMessage: 'settlement rejected',
      lastError: 'settlement rejected',
      retries: 0,
      deadLetteredAt: null,
    });
    const delay = entry.nextRetryAt!.getTime() - before;
    expect(delay).toBeGreaterThanOrEqual(env.EVENTLOG_RETRY_BASE_MS);
    expect(delay).toBeLessThan(env.EVENTLOG_RETRY_BASE_MS + 5_000);
  });
});

describe('EventPoller.replay', () => {
  it('fetches the recorded event back by ledger and runs its subscription handler', async () => {
    const event = buildEvent(205);
    const { rpc, getEvents } = createFakeRpc(300, [buildEvent(204), event, buildEvent(206)]);
    const handle = jest.fn().mockResolvedValue(undefined);

    await createPoller(rpc, handle).replay({
      eventType: 'escrow',
      transactionHash: event.txHash,
      ledgerSequence: 205,
      eventData: { eventId: event.id },
    });

    expect(getEvents).toHaveBeenCalledWith(expect.objectContaining({ startLedger: 205 }));
    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle.mock.calls[0][0].id).toBe(event.id);
  });

  it('throws when the node no longer serves the event', async () => {
    const { rpc } = createFakeRpc(300, []);
    const handle = jest.fn();

    await expect(
      createPoller(rpc, handle).replay({
        eventType: 'escrow',
        transactionHash: 'tx-gone',
        ledgerSequence: 120,
        eventData: { eventId: 'event-120' },
      }),
    ).rejects.toThrow(/no longer available at ledger 120/);
    expect(handle).not.toHaveBeenCalled();
  });

  it('throws when the recorded event type does not own the topic', async () => {
    const event = buildEvent(130);
    const { rpc } = createFakeRpc(300, [event]);

    await expect(
      createPoller(rpc, jest.fn()).replay({
        eventType: 'dispute',
        transactionHash: event.txHash,
        ledgerSequence: 130,
        eventData: { eventId: event.id },
      }),
    ).rejects.toThrow(/No dispute subscription/);
  });
});

// ─── Retry lifecycle ────────────────────────────────────────────────────────────

describe('EventLogRetryService — retry lifecycle', () => {
  it('failure → scheduled → success', async () => {
    const event = buildEvent(101);
    const { rpc } = createFakeRpc(101, [event]);
    const entry = await ingestFailingEvent(event, rpc);
    const handle = jest.fn().mockResolvedValue(undefined);
    const service = new EventLogRetryService(() => createPoller(rpc, handle));

    // Not yet due: the sweep leaves it alone.
    const early = await service.retryDue(new Date());
    expect(early.attempted).toBe(0);
    expect(handle).not.toHaveBeenCalled();

    const sweep = await service.retryDue(farFuture());

    expect(sweep).toEqual({ attempted: 1, processed: 1, rescheduled: 0, deadLettered: 0 });
    expect(handle).toHaveBeenCalledTimes(1);
    const stored = await EventLog.findById(entry._id).lean();
    expect(stored).toMatchObject({
      status: 'processed',
      retries: 1,
      errorMessage: null,
      nextRetryAt: null,
      lastError: 'settlement rejected',
    });
    expect(stored?.processedAt).toBeInstanceOf(Date);
  });

  it('failure → scheduled again with a doubled backoff', async () => {
    const event = buildEvent(101);
    const { rpc } = createFakeRpc(101, [event]);
    const entry = await ingestFailingEvent(event, rpc);
    const handle = jest.fn().mockRejectedValue(new Error('still rejected'));
    const service = new EventLogRetryService(() => createPoller(rpc, handle));
    const attemptedAt = Date.now();

    const sweep = await service.retryDue(farFuture());

    expect(sweep).toEqual({ attempted: 1, processed: 0, rescheduled: 1, deadLettered: 0 });
    const stored = await EventLog.findById(entry._id).lean();
    expect(stored).toMatchObject({
      status: 'failed',
      retries: 1,
      lastError: 'still rejected',
      errorMessage: 'still rejected',
      deadLetteredAt: null,
    });
    // Backoff runs from when the attempt happened, not from the sweep's cut-off.
    const delay = stored!.nextRetryAt!.getTime() - attemptedAt;
    expect(delay).toBeGreaterThanOrEqual(eventLogRetryDelayMs(2));
    expect(delay).toBeLessThan(eventLogRetryDelayMs(2) + 5_000);
    expect(eventLogRetryDelayMs(2)).toBe(
      Math.min(env.EVENTLOG_RETRY_BASE_MS * 2, env.EVENTLOG_RETRY_MAX_MS),
    );
  });

  it('failure → exhausted: escalates to the DLQ once and stops scheduling', async () => {
    env.EVENTLOG_RETRY_MAX_ATTEMPTS = 2;
    const event = buildEvent(101);
    const { rpc } = createFakeRpc(101, [event]);
    const entry = await ingestFailingEvent(event, rpc);
    const handle = jest.fn().mockRejectedValue(new Error('permanently rejected'));
    const service = new EventLogRetryService(() => createPoller(rpc, handle));

    const first = await service.retryDue(farFuture());
    const second = await service.retryDue(new Date(Date.now() + 96 * HOUR_MS));
    const third = await service.retryDue(new Date(Date.now() + 200 * HOUR_MS));

    expect(first).toMatchObject({ attempted: 1, rescheduled: 1 });
    expect(second).toMatchObject({ attempted: 1, deadLettered: 1 });
    // Dead-lettered entries are left for an operator.
    expect(third.attempted).toBe(0);
    expect(handle).toHaveBeenCalledTimes(2);

    const stored = await EventLog.findById(entry._id).lean();
    expect(stored).toMatchObject({
      status: 'failed',
      retries: 2,
      nextRetryAt: null,
      lastError: 'permanently rejected',
    });
    expect(stored?.deadLetteredAt).toBeInstanceOf(Date);

    const dlq = await DlqEntry.find({}).lean();
    expect(dlq).toHaveLength(1);
    expect(dlq[0]).toMatchObject({
      status: DlqStatus.PENDING,
      errorReason: 'permanently rejected',
      payload: {
        type: 'eventlog',
        eventLogId: String(entry._id),
        eventType: 'escrow',
        transactionHash: event.txHash,
        ledgerSequence: 101,
      },
    });

    const audit = await AuditLog.findOne({ action: 'eventlog.dead_lettered' }).lean();
    expect(audit).toMatchObject({ targetType: 'EventLog', actor: null });
    expect(String(audit?.targetId)).toBe(String(entry._id));
  });

  it('records the replay error when the event is no longer served by the node', async () => {
    const event = buildEvent(101);
    const { rpc } = createFakeRpc(101, [event]);
    const entry = await ingestFailingEvent(event, rpc);
    const emptyNode = createFakeRpc(500, []).rpc;
    const service = new EventLogRetryService(() => createPoller(emptyNode, jest.fn()));

    await service.retryDue(farFuture());

    const stored = await EventLog.findById(entry._id).lean();
    expect(stored?.lastError).toMatch(/no longer available at ledger 101/);
    expect(stored?.retries).toBe(1);
  });

  it('runs a due entry once when two sweeps race for it', async () => {
    const event = buildEvent(101);
    const { rpc } = createFakeRpc(101, [event]);
    await ingestFailingEvent(event, rpc);
    const handle = jest.fn().mockResolvedValue(undefined);
    const service = new EventLogRetryService(() => createPoller(rpc, handle));
    const now = farFuture();

    const [a, b] = await Promise.all([service.retryDue(now), service.retryDue(now)]);

    expect(a.attempted + b.attempted).toBe(1);
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it('retries the oldest due entries first, up to the batch size', async () => {
    env.EVENTLOG_RETRY_BATCH_SIZE = 2;
    const events = [buildEvent(101), buildEvent(102), buildEvent(103)];
    const { rpc } = createFakeRpc(103, events);
    const entries = [];
    for (const event of events) entries.push(await ingestFailingEvent(event, rpc));
    // Make the third entry the oldest due one.
    await EventLog.updateOne(
      { _id: entries[2]._id },
      { nextRetryAt: new Date(Date.now() - HOUR_MS) },
    );
    const handle = jest.fn().mockResolvedValue(undefined);
    const service = new EventLogRetryService(() => createPoller(rpc, handle));

    const sweep = await service.retryDue(farFuture());

    expect(sweep.attempted).toBe(2);
    expect(handle.mock.calls.map(([e]) => e.ledger)).toEqual([103, 101]);
    expect((await EventLog.findById(entries[1]._id).lean())?.status).toBe('failed');
  });

  it('skips the sweep when there is no contract to replay against', async () => {
    const event = buildEvent(101);
    const { rpc } = createFakeRpc(101, [event]);
    await ingestFailingEvent(event, rpc);

    const sweep = await new EventLogRetryService(() => null).retryDue(farFuture());

    expect(sweep.attempted).toBe(0);
    expect((await EventLog.findOne({}).lean())?.retries).toBe(0);
  });
});

// ─── Admin endpoints ────────────────────────────────────────────────────────────

describe('Admin EventLog retry endpoints', () => {
  const useReplayer = (rpc: ISorobanRpcClient, handle: jest.Mock): void => {
    jest.spyOn(eventPollerModule, 'getEventReplayer').mockReturnValue(createPoller(rpc, handle));
  };

  it('rejects unauthenticated and non-admin callers', async () => {
    const driver = await createUser(UserRole.DRIVER);
    const enterprise = await createUser(UserRole.ENTERPRISE);
    const id = String(new Types.ObjectId());

    expect((await request(app).get('/api/v1/admin/eventlog/failed')).status).toBe(401);
    expect((await request(app).post(`/api/v1/admin/eventlog/${id}/retry`)).status).toBe(401);

    for (const user of [driver, enterprise]) {
      const auth = `Bearer ${tokenFor(user._id)}`;
      expect(
        (await request(app).get('/api/v1/admin/eventlog/failed').set('Authorization', auth)).status,
      ).toBe(403);
      expect(
        (await request(app).post(`/api/v1/admin/eventlog/${id}/retry`).set('Authorization', auth))
          .status,
      ).toBe(403);
    }
  });

  it('lists only failed entries with their retry metadata', async () => {
    const admin = await createUser(UserRole.ADMIN);
    const failedEvent = buildEvent(101);
    const { rpc } = createFakeRpc(101, [failedEvent]);
    await ingestFailingEvent(failedEvent, rpc);
    await EventLog.create({
      eventType: 'escrow',
      transactionHash: 'tx-ok',
      ledgerSequence: 99,
      status: 'processed',
    });

    const res = await request(app)
      .get('/api/v1/admin/eventlog/failed')
      .set('Authorization', `Bearer ${tokenFor(admin._id)}`);

    expect(res.status).toBe(200);
    expect(res.body.data.events).toHaveLength(1);
    expect(res.body.data.events[0]).toMatchObject({
      transactionHash: failedEvent.txHash,
      status: 'failed',
      retries: 0,
      lastError: 'settlement rejected',
      deadLetteredAt: null,
    });
    expect(res.body.data.events[0].nextRetryAt).toEqual(expect.any(String));
    expect(res.body.data.meta).toMatchObject({ totalItems: 1 });
  });

  it('retries an entry now, ignoring its backoff, and audit-logs the admin', async () => {
    const admin = await createUser(UserRole.ADMIN);
    const event = buildEvent(101);
    const { rpc } = createFakeRpc(101, [event]);
    const entry = await ingestFailingEvent(event, rpc);
    const handle = jest.fn().mockResolvedValue(undefined);
    useReplayer(rpc, handle);

    const res = await request(app)
      .post(`/api/v1/admin/eventlog/${String(entry._id)}/retry`)
      .set('Authorization', `Bearer ${tokenFor(admin._id)}`);

    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe('processed');
    expect(res.body.data.event).toMatchObject({ status: 'processed', retries: 1 });
    expect(handle).toHaveBeenCalledTimes(1);

    const audit = await AuditLog.findOne({ action: 'eventlog.retry' }).lean();
    expect(String(audit?.actor)).toBe(String(admin._id));
    expect(String(audit?.targetId)).toBe(String(entry._id));
    expect(audit?.meta).toMatchObject({ outcome: 'processed', retries: 1 });
  });

  it('reports a scheduled outcome when the manual retry fails again', async () => {
    const admin = await createUser(UserRole.ADMIN);
    const event = buildEvent(101);
    const { rpc } = createFakeRpc(101, [event]);
    const entry = await ingestFailingEvent(event, rpc);
    useReplayer(rpc, jest.fn().mockRejectedValue(new Error('nope')));

    const res = await request(app)
      .post(`/api/v1/admin/eventlog/${String(entry._id)}/retry`)
      .set('Authorization', `Bearer ${tokenFor(admin._id)}`);

    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe('scheduled');
    expect(res.body.data.event).toMatchObject({ status: 'failed', retries: 1, lastError: 'nope' });
  });

  it('returns 400, 404 and 409 for bad ids, unknown entries and non-failed entries', async () => {
    const admin = await createUser(UserRole.ADMIN);
    const auth = `Bearer ${tokenFor(admin._id)}`;
    const { rpc } = createFakeRpc(101, []);
    useReplayer(rpc, jest.fn());
    const processed = await EventLog.create({
      eventType: 'escrow',
      transactionHash: 'tx-ok',
      ledgerSequence: 99,
      status: 'processed',
    });

    const bad = await request(app)
      .post('/api/v1/admin/eventlog/not-an-id/retry')
      .set('Authorization', auth);
    const missing = await request(app)
      .post(`/api/v1/admin/eventlog/${String(new Types.ObjectId())}/retry`)
      .set('Authorization', auth);
    const conflict = await request(app)
      .post(`/api/v1/admin/eventlog/${String(processed._id)}/retry`)
      .set('Authorization', auth);

    expect(bad.status).toBe(400);
    expect(missing.status).toBe(404);
    expect(conflict.status).toBe(409);
  });

  it('returns 503 when no contract is configured to replay against', async () => {
    const admin = await createUser(UserRole.ADMIN);
    const event = buildEvent(101);
    const { rpc } = createFakeRpc(101, [event]);
    const entry = await ingestFailingEvent(event, rpc);
    jest.spyOn(eventPollerModule, 'getEventReplayer').mockReturnValue(null);

    const res = await request(app)
      .post(`/api/v1/admin/eventlog/${String(entry._id)}/retry`)
      .set('Authorization', `Bearer ${tokenFor(admin._id)}`);

    expect(res.status).toBe(503);
    expect((await EventLog.findById(entry._id).lean())?.retries).toBe(0);
  });

  it('re-drives a dead-lettered entry from the DLQ retry endpoint', async () => {
    env.EVENTLOG_RETRY_MAX_ATTEMPTS = 1;
    const admin = await createUser(UserRole.ADMIN);
    const event = buildEvent(101);
    const { rpc } = createFakeRpc(101, [event]);
    const entry = await ingestFailingEvent(event, rpc);
    await new EventLogRetryService(() =>
      createPoller(rpc, jest.fn().mockRejectedValue(new Error('down'))),
    ).retryDue(farFuture());
    const dlq = await DlqEntry.findOne({}).lean();
    expect(dlq?.payload.eventLogId).toBe(String(entry._id));

    const handle = jest.fn().mockResolvedValue(undefined);
    useReplayer(rpc, handle);
    const res = await request(app)
      .post(`/api/v1/admin/dlq/${String(dlq!._id)}/retry`)
      .set('Authorization', `Bearer ${tokenFor(admin._id)}`);

    expect(res.status).toBe(200);
    expect(handle).toHaveBeenCalledTimes(1);
    expect((await EventLog.findById(entry._id).lean())?.status).toBe('processed');
    expect((await DlqEntry.findById(dlq!._id).lean())?.status).toBe(DlqStatus.RESOLVED);
    const audit = await AuditLog.findOne({ action: 'eventlog.retry' }).lean();
    expect(String(audit?.actor)).toBe(String(admin._id));
  });
});

// ─── Job ────────────────────────────────────────────────────────────────────────

describe('eventLogRetryJob', () => {
  it('runs one sweep through the retry service and swallows its errors', async () => {
    const { eventLogRetryService } = await import('../src/services/eventLogRetryService');
    const { runEventLogRetrySweep } = await import('../src/jobs/eventLogRetryJob');
    const retryDue = jest
      .spyOn(eventLogRetryService, 'retryDue')
      .mockResolvedValueOnce({ attempted: 2, processed: 1, rescheduled: 1, deadLettered: 0 })
      .mockResolvedValueOnce({ attempted: 0, processed: 0, rescheduled: 0, deadLettered: 0 })
      .mockRejectedValueOnce(new Error('mongo unavailable'));

    await runEventLogRetrySweep();
    await runEventLogRetrySweep();
    await expect(runEventLogRetrySweep()).resolves.toBeUndefined();

    expect(retryDue).toHaveBeenCalledTimes(3);
  });

  it('skips a tick while the previous sweep is still running', async () => {
    const { eventLogRetryService } = await import('../src/services/eventLogRetryService');
    const { runEventLogRetrySweep } = await import('../src/jobs/eventLogRetryJob');
    let finish: () => void = () => undefined;
    const retryDue = jest.spyOn(eventLogRetryService, 'retryDue').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ attempted: 0, processed: 0, rescheduled: 0, deadLettered: 0 });
        }),
    );

    const first = runEventLogRetrySweep();
    await runEventLogRetrySweep();
    finish();
    await first;

    expect(retryDue).toHaveBeenCalledTimes(1);
  });

  it('schedules once and stops cleanly', async () => {
    const { startEventLogRetryJob, stopEventLogRetryJob } = await import(
      '../src/jobs/eventLogRetryJob'
    );

    const task = startEventLogRetryJob();
    expect(startEventLogRetryJob()).toBe(task);
    stopEventLogRetryJob();
    stopEventLogRetryJob();
  });
});
