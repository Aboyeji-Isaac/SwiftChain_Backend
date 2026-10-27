/**
 * Delivery milestone event log (#245).
 *
 * Real in-memory MongoDB for the DeliveryEvent log; the three fan-out
 * consumers (notification, webhook, socket) are mocked so call order and
 * failure isolation can be asserted.
 */
import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

jest.mock('../src/services/notificationService', () => ({
  notificationService: { notifyDeliveryTransition: jest.fn() },
}));
jest.mock('../src/services/webhookService', () => ({
  webhookService: { dispatchDeliveryEvent: jest.fn() },
}));
jest.mock('../src/services/proofOfDeliveryService', () => ({
  proofOfDeliveryService: { assertProofOfDeliveryExists: jest.fn() },
}));
jest.mock('../src/sockets/connectionHandler', () => ({
  emitDeliveryStatusUpdated: jest.fn(),
}));

import DeliveryEvent, { DeliveryMilestone } from '../src/models/DeliveryEvent';
import { IDelivery, DeliveryStatus } from '../src/models/Delivery';
import { deliveryService } from '../src/services/delivery.service';
import { deliveryEventRepository } from '../src/repositories/DeliveryEventRepository';
import { deliveryRepository } from '../src/repositories/DeliveryRepository';
import { notificationService } from '../src/services/notificationService';
import { webhookService } from '../src/services/webhookService';
import { emitDeliveryStatusUpdated } from '../src/sockets/connectionHandler';

const notify = notificationService.notifyDeliveryTransition as unknown as jest.Mock;
const webhook = webhookService.dispatchDeliveryEvent as unknown as jest.Mock;
const socket = emitDeliveryStatusUpdated as unknown as jest.Mock;

const makeDelivery = (status: DeliveryStatus, extra: Record<string, unknown> = {}): IDelivery =>
  ({ _id: new Types.ObjectId(), status, contractId: 'CTEST', ...extra }) as unknown as IDelivery;

describe('delivery milestone events', () => {
  let mongod: MongoMemoryServer;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    await DeliveryEvent.init();
  }, 60_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  }, 30_000);

  beforeEach(() => {
    jest.restoreAllMocks();
    notify.mockReset().mockResolvedValue(undefined);
    webhook.mockReset().mockResolvedValue(undefined);
    socket.mockReset();
  });

  afterEach(async () => {
    await DeliveryEvent.deleteMany({});
  });

  describe('ordering', () => {
    it('assigns a gapless, increasing seq per delivery', async () => {
      const delivery = makeDelivery(DeliveryStatus.PENDING);
      const actor = { type: 'system' as const };

      await deliveryService.emitMilestone(
        delivery,
        { name: DeliveryMilestone.CREATED, fromStatus: null },
        actor,
      );
      delivery.status = DeliveryStatus.FUNDED;
      await deliveryService.emitMilestone(
        delivery,
        { name: DeliveryMilestone.FUNDED, fromStatus: DeliveryStatus.PENDING },
        actor,
      );
      delivery.status = DeliveryStatus.ASSIGNED;
      await deliveryService.emitMilestone(
        delivery,
        { name: DeliveryMilestone.ASSIGNED, fromStatus: DeliveryStatus.FUNDED },
        actor,
      );

      const page = await deliveryEventRepository.listByDelivery(String(delivery._id), 1, 10);
      expect(page.data.map((e) => e.seq)).toEqual([1, 2, 3]);
      expect(page.data.map((e) => e.event)).toEqual([
        DeliveryMilestone.CREATED,
        DeliveryMilestone.FUNDED,
        DeliveryMilestone.ASSIGNED,
      ]);
    });

    it('keeps seq independent between deliveries', async () => {
      const a = makeDelivery(DeliveryStatus.PENDING);
      const b = makeDelivery(DeliveryStatus.PENDING);
      const actor = { type: 'system' as const };
      const created = { name: DeliveryMilestone.CREATED, fromStatus: null };

      await deliveryService.emitMilestone(a, created, actor);
      await deliveryService.emitMilestone(a, created, actor);
      const first = await deliveryService.emitMilestone(b, created, actor);

      expect(first?.seq).toBe(1);
    });

    it('never produces duplicate seqs under concurrent writers', async () => {
      const delivery = makeDelivery(DeliveryStatus.PENDING);
      const actor = { type: 'system' as const };
      const created = { name: DeliveryMilestone.CREATED, fromStatus: null };

      await Promise.all([
        deliveryService.emitMilestone(delivery, created, actor),
        deliveryService.emitMilestone(delivery, created, actor),
        deliveryService.emitMilestone(delivery, created, actor),
      ]);

      const events = await DeliveryEvent.find({ delivery: delivery._id }).sort({ seq: 1 });
      expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    });
  });

  describe('fan-out', () => {
    it('runs notification -> webhook -> socket, after the record is persisted', async () => {
      const delivery = makeDelivery(DeliveryStatus.FUNDED);
      const order: string[] = [];
      notify.mockImplementation(async () => {
        order.push('notification');
      });
      webhook.mockImplementation(async () => {
        order.push('webhook');
      });
      socket.mockImplementation(() => {
        order.push('socket');
      });

      const record = await deliveryService.emitMilestone(
        delivery,
        { name: DeliveryMilestone.FUNDED, fromStatus: DeliveryStatus.PENDING },
        { type: 'system' },
      );

      expect(order).toEqual(['notification', 'webhook', 'socket']);
      expect(record?.seq).toBe(1);
      expect(socket).toHaveBeenCalledWith(
        String(delivery._id),
        expect.objectContaining({
          event: DeliveryMilestone.FUNDED,
          seq: 1,
          status: DeliveryStatus.FUNDED,
        }),
      );
    });

    it('still delivers to consumers when the record cannot be written', async () => {
      const delivery = makeDelivery(DeliveryStatus.FUNDED);
      jest.spyOn(deliveryEventRepository, 'append').mockRejectedValue(new Error('db down'));

      const record = await deliveryService.emitMilestone(
        delivery,
        { name: DeliveryMilestone.FUNDED, fromStatus: DeliveryStatus.PENDING },
        { type: 'system' },
      );

      expect(record).toBeNull();
      expect(notify).toHaveBeenCalledTimes(1);
      expect(webhook).toHaveBeenCalledTimes(1);
      expect(socket).toHaveBeenCalledTimes(1);
    });
  });

  describe('fire-after-commit isolation', () => {
    it('a throwing consumer neither rejects emitMilestone nor skips later consumers', async () => {
      const delivery = makeDelivery(DeliveryStatus.FUNDED);
      notify.mockRejectedValue(new Error('notify boom'));
      webhook.mockRejectedValue(new Error('webhook boom'));
      socket.mockImplementation(() => {
        throw new Error('socket boom');
      });

      const record = await deliveryService.emitMilestone(
        delivery,
        { name: DeliveryMilestone.FUNDED, fromStatus: DeliveryStatus.PENDING },
        { type: 'system' },
      );

      expect(record?.seq).toBe(1);
      expect(await DeliveryEvent.countDocuments({ delivery: delivery._id })).toBe(1);
      expect(webhook).toHaveBeenCalledTimes(1);
      expect(socket).toHaveBeenCalledTimes(1);
    });

    it('updateStatus emits only after the transition commits, and consumer failures cannot break it', async () => {
      const current = makeDelivery(DeliveryStatus.ASSIGNED);
      const updated = { ...current, status: DeliveryStatus.IN_PROGRESS } as unknown as IDelivery;
      const id = String(current._id);
      const order: string[] = [];

      jest.spyOn(deliveryRepository, 'findById').mockResolvedValue(current);
      jest.spyOn(deliveryRepository, 'transitionStatus').mockImplementation(async () => {
        order.push('commit');
        return updated;
      });
      notify.mockImplementation(async () => {
        order.push('notification');
      });
      webhook.mockImplementation(async () => {
        order.push('webhook');
        throw new Error('webhook boom');
      });
      socket.mockImplementation(() => {
        order.push('socket');
      });

      const result = await deliveryService.updateStatus(id, DeliveryStatus.IN_PROGRESS, {
        type: 'user',
        id: 'user-1',
      });

      expect(result).toBe(updated);
      expect(order).toEqual(['commit', 'notification', 'webhook', 'socket']);

      const [event] = await DeliveryEvent.find({ delivery: id });
      expect(event.event).toBe(DeliveryMilestone.IN_PROGRESS);
      expect(event.fromStatus).toBe(DeliveryStatus.ASSIGNED);
      expect(event.toStatus).toBe(DeliveryStatus.IN_PROGRESS);
      expect(event.actor).toMatchObject({ type: 'user', id: 'user-1' });
    });

    it('does not emit anything when the transition is rejected', async () => {
      const current = makeDelivery(DeliveryStatus.COMPLETED);
      jest.spyOn(deliveryRepository, 'findById').mockResolvedValue(current);

      await expect(
        deliveryService.updateStatus(String(current._id), DeliveryStatus.IN_PROGRESS),
      ).rejects.toMatchObject({ statusCode: 400 });

      expect(await DeliveryEvent.countDocuments({})).toBe(0);
      expect(notify).not.toHaveBeenCalled();
    });
  });

  describe('listMilestones authorization', () => {
    const setup = async (): Promise<string> => {
      const delivery = makeDelivery(DeliveryStatus.ASSIGNED, {
        userId: 'owner-1',
        driverId: 'driver-1',
      });
      jest.spyOn(deliveryRepository, 'findById').mockResolvedValue(delivery);
      await deliveryService.emitMilestone(
        delivery,
        { name: DeliveryMilestone.ASSIGNED, fromStatus: DeliveryStatus.FUNDED },
        { type: 'system' },
      );
      return String(delivery._id);
    };

    it('lets the owner, the driver and an admin read the log', async () => {
      const id = await setup();
      for (const requester of [
        { id: 'owner-1', role: 'customer' },
        { id: 'driver-1', role: 'driver' },
        { id: 'someone-else', role: 'admin' },
      ]) {
        const page = await deliveryService.listMilestones(id, requester);
        expect(page.total).toBe(1);
        expect(page.data[0].seq).toBe(1);
      }
    });

    it('rejects a non-participant with 403', async () => {
      const id = await setup();
      await expect(
        deliveryService.listMilestones(id, { id: 'stranger', role: 'driver' }),
      ).rejects.toMatchObject({ statusCode: 403 });
    });

    it('rejects a malformed id with 400 and an unknown delivery with 404', async () => {
      await expect(
        deliveryService.listMilestones('not-an-id', { id: 'x', role: 'admin' }),
      ).rejects.toMatchObject({ statusCode: 400 });

      jest.spyOn(deliveryRepository, 'findById').mockResolvedValue(null);
      await expect(
        deliveryService.listMilestones(String(new Types.ObjectId()), { id: 'x', role: 'admin' }),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });
});
