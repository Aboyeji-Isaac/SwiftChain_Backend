/**
 * Integration tests for the event poller.
 *
 * EventLog and IndexerStatus are real models on an in-memory MongoDB, so the
 * unique {transactionHash, eventType} index and the checkpoint behaviour are
 * exercised for real. The Soroban RPC node is replaced with a fake that pages
 * through a fixed event list, which keeps the tests off the network.
 */

import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { rpc as StellarRpc, xdr } from '@stellar/stellar-sdk';
import EventLog from '../src/models/EventLog';
import { IndexerStatus } from '../src/models/IndexerStatus';
import { EventPoller, EventSubscription } from '../src/services/eventPoller';
import type {
  ISorobanRpcClient,
  SorobanGetEventsRequest,
} from '../src/services/providers/sorobanRpcClient';

jest.mock('../src/config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const NETWORK = 'testnet';
const CONTRACT_ID = 'CTESTESCROWCONTRACT';
const FUNDED_TOPIC = 'escrow_funded';
const RELEASED_TOPIC = 'escrow_released';

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await Promise.all([EventLog.init(), IndexerStatus.init()]);
}, 120_000);

afterEach(async () => {
  await Promise.all([EventLog.deleteMany({}), IndexerStatus.deleteMany({})]);
  jest.clearAllMocks();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

// ─── Fixtures ──────────────────────────────────────────────────────────────────

/** A contract event shaped like the SDK's parsed `getEvents` response. */
const buildEvent = (
  overrides: Partial<{ id: string; ledger: number; txHash: string; topic: string }> = {},
): StellarRpc.Api.EventResponse => {
  const ledger = overrides.ledger ?? 101;
  const id = overrides.id ?? `event-${ledger}`;
  return {
    id,
    type: 'contract',
    ledger,
    ledgerClosedAt: '2026-10-21T00:00:00Z',
    contractId: CONTRACT_ID,
    txHash: overrides.txHash ?? `tx-${id}`,
    topic: [xdr.ScVal.scvSymbol(overrides.topic ?? FUNDED_TOPIC)],
    value: xdr.ScVal.scvVoid(),
    inSuccessfulContractCall: true,
    pagingToken: id,
  } as unknown as StellarRpc.Api.EventResponse;
};

/**
 * Fake RPC node. `getEvents` returns events from the start ledger in pages of
 * `limit`, with an index-based cursor, mirroring how the real node pages.
 */
const createFakeRpc = (
  latestLedger: number,
  events: StellarRpc.Api.EventResponse[],
): {
  rpc: ISorobanRpcClient;
  getLatestLedger: jest.Mock;
  getEvents: jest.Mock;
} => {
  const getLatestLedger = jest.fn(async () => ({ sequence: latestLedger }));
  const getEvents = jest.fn(async (request: SorobanGetEventsRequest) => {
    const limit = request.limit ?? 100;
    const start =
      request.cursor !== undefined
        ? Number(request.cursor)
        : Math.max(
            0,
            events.findIndex((event) => event.ledger >= (request.startLedger ?? 0)),
          );
    const page = events.slice(start, start + limit);
    return {
      latestLedger,
      events: page,
      cursor: String(start + page.length),
    };
  });

  return {
    rpc: { getLatestLedger, getEvents } as unknown as ISorobanRpcClient,
    getLatestLedger,
    getEvents,
  };
};

const subscriptionFor = (
  handle: EventSubscription['handle'],
  topic = FUNDED_TOPIC,
): EventSubscription => ({ eventType: 'escrow', topic, handle });

const createPoller = (
  rpc: ISorobanRpcClient,
  handle: EventSubscription['handle'],
  pageSize = 100,
): EventPoller =>
  new EventPoller({
    rpc,
    network: NETWORK,
    contractId: CONTRACT_ID,
    subscriptions: [subscriptionFor(handle)],
    intervalMs: 60_000,
    pageSize,
  });

const setCheckpoint = async (lastProcessedLedger: number): Promise<void> => {
  await IndexerStatus.updateOne(
    { network: NETWORK },
    { $set: { lastProcessedLedger, lastProcessedAt: new Date() } },
    { upsert: true },
  );
};

const readCheckpoint = async (): Promise<number | undefined> =>
  (await IndexerStatus.findOne({ network: NETWORK }).lean())?.lastProcessedLedger;

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('EventPoller', () => {
  describe('ingestion', () => {
    it('records each new event, dispatches it to the handler, and advances the checkpoint', async () => {
      await setCheckpoint(100);
      const events = [
        buildEvent({ ledger: 101, txHash: 'tx-1' }),
        buildEvent({ ledger: 103, txHash: 'tx-2' }),
      ];
      const { rpc } = createFakeRpc(105, events);
      const handle = jest.fn().mockResolvedValue(undefined);

      const result = await createPoller(rpc, handle).pollOnce();

      expect(handle).toHaveBeenCalledTimes(2);
      expect(handle).toHaveBeenNthCalledWith(1, events[0]);
      expect(handle).toHaveBeenNthCalledWith(2, events[1]);

      const rows = await EventLog.find({}).sort({ ledgerSequence: 1 }).lean();
      expect(rows.map((row) => [row.transactionHash, row.status, row.ledgerSequence])).toEqual([
        ['tx-1', 'processed', 101],
        ['tx-2', 'processed', 103],
      ]);
      expect(rows[0].processedAt).toBeInstanceOf(Date);
      expect(rows[0].contractId).toBe(CONTRACT_ID);

      expect(result).toMatchObject({
        fromLedger: 101,
        toLedger: 105,
        fetched: 2,
        processed: 2,
        duplicates: 0,
        failed: 0,
      });
      expect(await readCheckpoint()).toBe(105);
    });

    it('ignores events for topics that have no subscription', async () => {
      await setCheckpoint(100);
      const events = [
        buildEvent({ ledger: 101, txHash: 'tx-released', topic: RELEASED_TOPIC }),
        buildEvent({ ledger: 102, txHash: 'tx-funded' }),
      ];
      const { rpc } = createFakeRpc(105, events);
      const handle = jest.fn().mockResolvedValue(undefined);

      const result = await createPoller(rpc, handle).pollOnce();

      expect(handle).toHaveBeenCalledTimes(1);
      expect(handle).toHaveBeenCalledWith(events[1]);
      expect(await EventLog.countDocuments({})).toBe(1);
      expect(result).toMatchObject({ fetched: 2, processed: 1 });
    });

    it('pages through getEvents until the node returns no more events', async () => {
      await setCheckpoint(100);
      const events = [101, 102, 103, 104, 105].map((ledger) => buildEvent({ ledger }));
      const { rpc, getEvents } = createFakeRpc(105, events);
      const handle = jest.fn().mockResolvedValue(undefined);

      const result = await createPoller(rpc, handle, 2).pollOnce();

      expect(handle).toHaveBeenCalledTimes(5);
      expect(result.processed).toBe(5);
      expect(getEvents).toHaveBeenCalledTimes(4);
      expect(getEvents.mock.calls[0][0]).toMatchObject({ startLedger: 101, limit: 2 });
      expect(getEvents.mock.calls[1][0]).toMatchObject({ cursor: '2' });
      expect(getEvents.mock.calls[1][0]).not.toHaveProperty('startLedger');
    });

    it('does not process events beyond the latest ledger of the cycle', async () => {
      await setCheckpoint(100);
      const events = [
        buildEvent({ ledger: 105, txHash: 'tx-head' }),
        buildEvent({ ledger: 106, txHash: 'tx-future' }),
      ];
      const { rpc } = createFakeRpc(105, events);
      const handle = jest.fn().mockResolvedValue(undefined);

      await createPoller(rpc, handle).pollOnce();

      expect(handle).toHaveBeenCalledTimes(1);
      expect(await EventLog.findOne({ transactionHash: 'tx-future' })).toBeNull();
      expect(await readCheckpoint()).toBe(105);
    });
  });

  describe('checkpointing', () => {
    it('starts at the ledger head when no checkpoint exists, instead of replaying history', async () => {
      const events = [
        buildEvent({ ledger: 50, txHash: 'tx-old' }),
        buildEvent({ ledger: 105, txHash: 'tx-head' }),
      ];
      const { rpc } = createFakeRpc(105, events);
      const handle = jest.fn().mockResolvedValue(undefined);

      const result = await createPoller(rpc, handle).pollOnce();

      expect(result.fromLedger).toBe(105);
      expect(handle).toHaveBeenCalledTimes(1);
      expect(handle).toHaveBeenCalledWith(events[1]);
      expect(await readCheckpoint()).toBe(105);
    });

    it('makes no RPC event calls when the checkpoint is already at the head', async () => {
      await setCheckpoint(105);
      const { rpc, getEvents } = createFakeRpc(105, [buildEvent({ ledger: 105 })]);
      const handle = jest.fn();

      const result = await createPoller(rpc, handle).pollOnce();

      expect(getEvents).not.toHaveBeenCalled();
      expect(handle).not.toHaveBeenCalled();
      expect(result.fetched).toBe(0);
    });

    it('leaves the checkpoint unchanged when the RPC call fails', async () => {
      await setCheckpoint(100);
      const rpc = {
        getLatestLedger: jest.fn(async () => ({ sequence: 105 })),
        getEvents: jest.fn(async () => {
          throw new Error('rpc unavailable');
        }),
      } as unknown as ISorobanRpcClient;

      await expect(createPoller(rpc, jest.fn()).pollOnce()).rejects.toThrow('rpc unavailable');
      expect(await readCheckpoint()).toBe(100);
    });
  });

  describe('deduplication and failures', () => {
    it('skips events already recorded when the checkpoint is replayed', async () => {
      await setCheckpoint(100);
      const events = [
        buildEvent({ ledger: 101, txHash: 'tx-1' }),
        buildEvent({ ledger: 103, txHash: 'tx-2' }),
      ];
      const { rpc } = createFakeRpc(105, events);
      const handle = jest.fn().mockResolvedValue(undefined);
      const poller = createPoller(rpc, handle);

      await poller.pollOnce();
      await setCheckpoint(100);
      const replay = await poller.pollOnce();

      expect(handle).toHaveBeenCalledTimes(2);
      expect(replay).toMatchObject({ fetched: 2, processed: 0, duplicates: 2 });
      expect(await EventLog.countDocuments({})).toBe(2);
    });

    it('marks an event as failed with its error and still processes the others', async () => {
      await setCheckpoint(100);
      const events = [
        buildEvent({ ledger: 101, txHash: 'tx-1' }),
        buildEvent({ ledger: 102, txHash: 'tx-2' }),
      ];
      const { rpc } = createFakeRpc(105, events);
      const handle = jest.fn(async (event: StellarRpc.Api.EventResponse) => {
        if (event.txHash === 'tx-1') throw new Error('settlement rejected');
      });

      const result = await createPoller(rpc, handle).pollOnce();

      const failed = await EventLog.findOne({ transactionHash: 'tx-1' }).lean();
      const processed = await EventLog.findOne({ transactionHash: 'tx-2' }).lean();
      expect(failed).toMatchObject({ status: 'failed', errorMessage: 'settlement rejected' });
      expect(processed?.status).toBe('processed');
      expect(result).toMatchObject({ processed: 1, failed: 1 });
      expect(await readCheckpoint()).toBe(105);
    });

    it('does not re-run a failed event on a later cycle', async () => {
      await setCheckpoint(100);
      const { rpc } = createFakeRpc(105, [buildEvent({ ledger: 101, txHash: 'tx-1' })]);
      const handle = jest.fn().mockRejectedValue(new Error('boom'));
      const poller = createPoller(rpc, handle);

      await poller.pollOnce();
      await setCheckpoint(100);
      const replay = await poller.pollOnce();

      expect(handle).toHaveBeenCalledTimes(1);
      expect(replay.duplicates).toBe(1);
    });

    it('processes an event left pending by an interrupted cycle without creating a second record', async () => {
      await setCheckpoint(100);
      await EventLog.create({
        eventType: 'escrow',
        transactionHash: 'tx-1',
        ledgerSequence: 101,
        contractId: CONTRACT_ID,
        status: 'pending',
      });
      const { rpc } = createFakeRpc(105, [buildEvent({ ledger: 101, txHash: 'tx-1' })]);
      const handle = jest.fn().mockResolvedValue(undefined);

      const result = await createPoller(rpc, handle).pollOnce();

      expect(handle).toHaveBeenCalledTimes(1);
      expect(result.processed).toBe(1);
      expect(await EventLog.countDocuments({ transactionHash: 'tx-1' })).toBe(1);
      expect((await EventLog.findOne({ transactionHash: 'tx-1' }).lean())?.status).toBe(
        'processed',
      );
    });
  });

  describe('lifecycle', () => {
    it('runs an immediate cycle on start and stops scheduling on stop', async () => {
      const { rpc, getLatestLedger } = createFakeRpc(100, []);
      const poller = createPoller(rpc, jest.fn());

      poller.start();
      await flush();
      expect(getLatestLedger).toHaveBeenCalledTimes(1);

      poller.stop();
      poller.stop();
      await flush();
      expect(getLatestLedger).toHaveBeenCalledTimes(1);
    });
  });
});
