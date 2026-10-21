/**
 * Unit tests for EscrowIndexerService.
 *
 * Covers the escrow_released / escrow_refunded sync handlers that move an
 * escrow into a terminal state from on-chain Soroban events, and the
 * getEscrowByEscrowId lookup used by the indexer controller.
 *
 * A regression here could double-settle an escrow or leave it in the wrong
 * state, so every assertion reads the persisted document back from a real
 * (in-process) MongoDB instance rather than inspecting mocked calls.
 */

import { randomBytes } from 'crypto';
import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { StrKey } from '@stellar/stellar-sdk';

import { EscrowIndexerService } from '../../../src/services/escrowIndexerService';
import Escrow, { EscrowStatus, IEscrow, IEscrowTransaction } from '../../../src/models/Escrow';
import {
  EscrowResolutionEventType,
  EscrowResolvedEvent,
} from '../../../src/indexer/types/escrowEvents';
import logger from '../../../src/config/logger';

// ─── Fixture builders ─────────────────────────────────────────────────────────

/** A random 32-byte Stellar transaction hash (64 hex chars). */
const newTxHash = (): string => randomBytes(32).toString('hex');

/** A valid, random Soroban contract address (`C...`). */
const newContractId = (): string => StrKey.encodeContract(randomBytes(32));

/** A valid, random Stellar account address (`G...`). */
const newAccount = (): string => StrKey.encodeEd25519PublicKey(randomBytes(32));

/** Monotonic ledger sequence so each event is strictly newer than the last. */
let ledgerSeq = 1_000_000;
const nextLedger = (): number => ++ledgerSeq;

const nowUnix = (): number => Math.floor(Date.now() / 1000);

interface SeedOptions {
  status?: EscrowStatus;
  transactions?: Array<Omit<IEscrowTransaction, 'recordedAt'> & { recordedAt?: Date }>;
}

/** Persists a funded escrow and returns the stored document. */
const seedEscrow = async (options: SeedOptions = {}): Promise<IEscrow> => {
  const fundHash = newTxHash();
  return Escrow.create({
    delivery: new Types.ObjectId(),
    status: options.status ?? EscrowStatus.LOCKED,
    amount: 125.5,
    assetCode: 'USDC',
    assetIssuer: newAccount(),
    contractId: newContractId(),
    payerAddress: newAccount(),
    payeeAddress: newAccount(),
    lockTransactionHash: fundHash,
    lockedAt: new Date(),
    transactions: options.transactions ?? [
      { hash: fundHash, type: 'fund', ledger: nextLedger(), recordedAt: new Date() },
    ],
  });
};

/** Builds a typed resolution event targeting the given escrow identifier. */
const buildEvent = (
  type: EscrowResolutionEventType,
  escrow: IEscrow,
  overrides: Partial<EscrowResolvedEvent> = {},
): EscrowResolvedEvent => ({
  type,
  escrowId: escrow._id.toString(),
  transactionHash: newTxHash(),
  amount: String(escrow.amount),
  asset: escrow.assetCode,
  ledger: nextLedger(),
  timestamp: nowUnix(),
  recipient: (type === 'escrow_released' ? escrow.payeeAddress : escrow.payerAddress) as string,
  ...overrides,
});

const reload = async (escrow: IEscrow): Promise<IEscrow> => {
  const doc = await Escrow.findById(escrow._id).lean<IEscrow>().exec();
  if (!doc) throw new Error(`Escrow ${escrow._id.toString()} vanished from the database`);
  return doc;
};

// ─── Release / refund parameterisation ────────────────────────────────────────

interface ResolutionCase {
  label: string;
  type: EscrowResolutionEventType;
  status: EscrowStatus;
  txType: 'release' | 'refund';
  hashField: 'releaseTransactionHash' | 'refundTransactionHash';
  timeField: 'releasedAt' | 'refundedAt';
  run: (svc: EscrowIndexerService, event: EscrowResolvedEvent) => Promise<void>;
}

const RELEASE: ResolutionCase = {
  label: 'handleEscrowReleased',
  type: 'escrow_released',
  status: EscrowStatus.RELEASED,
  txType: 'release',
  hashField: 'releaseTransactionHash',
  timeField: 'releasedAt',
  run: (svc, event) => svc.handleEscrowReleased(event),
};

const REFUND: ResolutionCase = {
  label: 'handleEscrowRefunded',
  type: 'escrow_refunded',
  status: EscrowStatus.REFUNDED,
  txType: 'refund',
  hashField: 'refundTransactionHash',
  timeField: 'refundedAt',
  run: (svc, event) => svc.handleEscrowRefunded(event),
};

/** The opposite resolution, used for mismatched-event assertions. */
const opposite = (c: ResolutionCase): ResolutionCase => (c === RELEASE ? REFUND : RELEASE);

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('EscrowIndexerService', () => {
  let mongod: MongoMemoryServer;
  let service: EscrowIndexerService;
  let infoSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    // Build the unique `transactions.hash` / `contractId` indexes before asserting on them.
    await Escrow.init();
  }, 120_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  }, 30_000);

  beforeEach(() => {
    service = new EscrowIndexerService();
    infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger);
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await Escrow.deleteMany({});
  });

  describe.each([RELEASE, REFUND])('$label', (c) => {
    describe('on a non-terminal escrow', () => {
      it.each([EscrowStatus.LOCKED, EscrowStatus.PENDING, EscrowStatus.DISPUTED])(
        `transitions a %s escrow to ${c.status} and appends the ${c.txType} transaction`,
        async (startStatus) => {
          const escrow = await seedEscrow({ status: startStatus });
          const event = buildEvent(c.type, escrow);

          await c.run(service, event);

          const stored = await reload(escrow);
          expect(stored.status).toBe(c.status);
          expect(stored[c.hashField]).toBe(event.transactionHash);
          expect(stored[c.timeField]?.getTime()).toBe(event.timestamp * 1000);
          expect(stored.lastSyncedLedger).toBe(event.ledger);

          expect(stored.transactions).toHaveLength(2);
          const appended = stored.transactions[1];
          expect(appended.hash).toBe(event.transactionHash);
          expect(appended.type).toBe(c.txType);
          expect(appended.ledger).toBe(event.ledger);
          expect(appended.recordedAt).toBeInstanceOf(Date);
          // The original fund transaction is preserved.
          expect(stored.transactions[0].type).toBe('fund');

          expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining(event.transactionHash));
        },
      );

      it('resolves an escrow referenced by its Soroban contract id', async () => {
        const escrow = await seedEscrow();
        const event = buildEvent(c.type, escrow, { escrowId: escrow.contractId as string });

        await c.run(service, event);

        const stored = await reload(escrow);
        expect(stored.status).toBe(c.status);
        expect(stored.transactions.map((t) => t.hash)).toContain(event.transactionHash);
      });

      it('only updates the targeted escrow', async () => {
        const target = await seedEscrow();
        const bystander = await seedEscrow();
        const bystanderBefore = await reload(bystander);

        await c.run(service, buildEvent(c.type, target));

        expect((await reload(target)).status).toBe(c.status);
        const bystanderAfter = await reload(bystander);
        expect(bystanderAfter.status).toBe(bystanderBefore.status);
        expect(bystanderAfter.transactions).toHaveLength(bystanderBefore.transactions.length);
      });
    });

    describe('terminal-status guard', () => {
      it(`no-ops a second, different ${c.type} event after the escrow is settled`, async () => {
        const escrow = await seedEscrow();
        const first = buildEvent(c.type, escrow);
        await c.run(service, first);
        const settled = await reload(escrow);

        const second = buildEvent(c.type, escrow);
        await expect(c.run(service, second)).resolves.toBeUndefined();

        const stored = await reload(escrow);
        expect(stored.status).toBe(c.status);
        expect(stored[c.hashField]).toBe(first.transactionHash);
        expect(stored.lastSyncedLedger).toBe(first.ledger);
        expect(stored.transactions).toHaveLength(settled.transactions.length);
        expect(stored.transactions.map((t) => t.hash)).not.toContain(second.transactionHash);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('already resolved or not found'),
        );
      });

      it(`rejects a mismatched ${opposite(c).type} event after ${c.type}`, async () => {
        const escrow = await seedEscrow();
        const first = buildEvent(c.type, escrow);
        await c.run(service, first);

        const mismatched = buildEvent(opposite(c).type, escrow);
        await opposite(c).run(service, mismatched);

        const stored = await reload(escrow);
        expect(stored.status).toBe(c.status);
        expect(stored[c.hashField]).toBe(first.transactionHash);
        expect(stored[opposite(c).hashField]).toBeUndefined();
        expect(stored[opposite(c).timeField]).toBeUndefined();
        expect(stored.transactions.filter((t) => t.type === opposite(c).txType)).toHaveLength(0);
      });

      it.each([EscrowStatus.RELEASED, EscrowStatus.REFUNDED])(
        `leaves an escrow seeded as %s untouched`,
        async (terminal) => {
          const escrow = await seedEscrow({ status: terminal });
          const before = await reload(escrow);

          await c.run(service, buildEvent(c.type, escrow));

          const stored = await reload(escrow);
          expect(stored.status).toBe(terminal);
          expect(stored.transactions).toHaveLength(before.transactions.length);
          expect(stored.lastSyncedLedger).toBe(before.lastSyncedLedger);
          expect(stored.updatedAt.getTime()).toBe(before.updatedAt.getTime());
        },
      );
    });

    describe('idempotency', () => {
      it('ingesting the same transaction hash twice applies it once', async () => {
        const escrow = await seedEscrow();
        const event = buildEvent(c.type, escrow);

        await c.run(service, event);
        const afterFirst = await reload(escrow);
        await c.run(service, event);

        const stored = await reload(escrow);
        expect(stored.transactions.filter((t) => t.hash === event.transactionHash)).toHaveLength(1);
        expect(stored.transactions).toHaveLength(afterFirst.transactions.length);
        expect(stored.updatedAt.getTime()).toBe(afterFirst.updatedAt.getTime());
        expect(infoSpy).toHaveBeenCalledWith(
          expect.stringContaining(`Skipping already-processed ${c.type}`),
        );
      });

      it('replays via contract id are deduplicated as well', async () => {
        const escrow = await seedEscrow();
        const event = buildEvent(c.type, escrow);
        await c.run(service, event);

        await c.run(service, { ...event, escrowId: escrow.contractId as string });

        const stored = await reload(escrow);
        expect(stored.transactions.filter((t) => t.hash === event.transactionHash)).toHaveLength(1);
      });

      it('concurrent duplicate deliveries of the same event apply exactly once', async () => {
        const escrow = await seedEscrow();
        const event = buildEvent(c.type, escrow);

        await Promise.allSettled([c.run(service, event), c.run(service, event)]);

        const stored = await reload(escrow);
        expect(stored.status).toBe(c.status);
        expect(stored.transactions.filter((t) => t.hash === event.transactionHash)).toHaveLength(1);
      });

      it('enforces transactions.hash uniqueness across escrows at the database level', async () => {
        const first = await seedEscrow();
        const second = await seedEscrow();
        const event = buildEvent(c.type, first);
        await c.run(service, event);

        // Re-using the same on-chain hash for a different escrow must never succeed.
        await expect(
          c.run(service, { ...event, escrowId: second._id.toString() }),
        ).rejects.toMatchObject({ code: 11000 });

        const untouched = await reload(second);
        expect(untouched.status).toBe(EscrowStatus.LOCKED);
        expect(untouched.transactions.map((t) => t.hash)).not.toContain(event.transactionHash);
      });
    });

    describe('missing documents', () => {
      it('no-ops and warns for an unknown ObjectId', async () => {
        const bystander = await seedEscrow();
        const missingId = new Types.ObjectId().toHexString();
        const event = buildEvent(c.type, bystander, { escrowId: missingId });

        await expect(c.run(service, event)).resolves.toBeUndefined();

        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`escrowId=${missingId}`));
        expect((await reload(bystander)).status).toBe(EscrowStatus.LOCKED);
        expect(await Escrow.countDocuments({ 'transactions.hash': event.transactionHash })).toBe(0);
      });

      it('no-ops for an unknown contract id', async () => {
        const bystander = await seedEscrow();
        const missingContract = newContractId();
        const event = buildEvent(c.type, bystander, { escrowId: missingContract });

        await expect(c.run(service, event)).resolves.toBeUndefined();

        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(missingContract));
        expect(await Escrow.countDocuments({ 'transactions.hash': event.transactionHash })).toBe(0);
      });
    });

    it('propagates database errors to the caller', async () => {
      const escrow = await seedEscrow();
      const dbError = new Error('MongoNetworkError: connection reset');
      jest.spyOn(Escrow, 'findOneAndUpdate').mockRejectedValueOnce(dbError as never);

      await expect(c.run(service, buildEvent(c.type, escrow))).rejects.toBe(dbError);
      expect((await reload(escrow)).status).toBe(EscrowStatus.LOCKED);
    });
  });

  describe('getEscrowByEscrowId', () => {
    it('returns the escrow by MongoDB ObjectId', async () => {
      const escrow = await seedEscrow();

      const found = await service.getEscrowByEscrowId(escrow._id.toString());

      expect(found).not.toBeNull();
      expect(found?._id.toString()).toBe(escrow._id.toString());
      expect(found?.contractId).toBe(escrow.contractId);
      expect(found?.status).toBe(EscrowStatus.LOCKED);
    });

    it('returns the escrow by Soroban contract id', async () => {
      const escrow = await seedEscrow();

      const found = await service.getEscrowByEscrowId(escrow.contractId as string);

      expect(found?._id.toString()).toBe(escrow._id.toString());
    });

    it('reflects the state written by the sync handlers', async () => {
      const escrow = await seedEscrow();
      const event = buildEvent('escrow_released', escrow);
      await service.handleEscrowReleased(event);

      const found = await service.getEscrowByEscrowId(escrow._id.toString());

      expect(found?.status).toBe(EscrowStatus.RELEASED);
      expect(found?.releaseTransactionHash).toBe(event.transactionHash);
      expect(found?.transactions.map((t) => t.hash)).toContain(event.transactionHash);
    });

    it('returns a plain object (lean) rather than a hydrated document', async () => {
      const escrow = await seedEscrow();

      const found = await service.getEscrowByEscrowId(escrow._id.toString());

      expect(found).not.toBeInstanceOf(mongoose.Document);
    });

    it('returns null for an unknown ObjectId', async () => {
      await seedEscrow();
      expect(await service.getEscrowByEscrowId(new Types.ObjectId().toHexString())).toBeNull();
    });

    it('returns null for an unknown contract id', async () => {
      await seedEscrow();
      expect(await service.getEscrowByEscrowId(newContractId())).toBeNull();
    });
  });
});
