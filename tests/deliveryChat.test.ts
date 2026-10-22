import request from 'supertest';
import mongoose, { Types } from 'mongoose';
import jwt from 'jsonwebtoken';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import User from '../src/models/User';
import Delivery, { DeliveryStatus } from '../src/models/Delivery';
import ChatMessage from '../src/models/ChatMessage';
import { UserRole, UserStatus } from '../src/interfaces/IUser';
import { chatMessageService } from '../src/sockets/chatMessage.service';
import socketService from '../src/sockets/socketService';
import { deliveryRoom } from '../src/sockets/location.service';

jest.mock('../src/config/database', () => ({
  connectDatabase: jest.fn(),
}));

jest.mock('../src/config/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: MongoMemoryServer;
const JWT_SECRET = 'test-secret-key-16chars';

const signToken = (userId: string): string => jwt.sign({ userId }, JWT_SECRET, { expiresIn: '1h' });

const createUser = async (
  role: UserRole = UserRole.USER,
  emailPrefix: string = 'user',
): Promise<InstanceType<typeof User>> =>
  User.create({
    firstName: 'Test',
    lastName: 'Participant',
    email: `${emailPrefix}-${Date.now()}-${Math.random()}@example.com`,
    password: 'Password123!',
    role,
    status: UserStatus.ACTIVE,
  });

describe('Delivery-Scoped Chat Messages (Issue #244)', () => {
  let senderUser: InstanceType<typeof User>;
  let recipientUser: InstanceType<typeof User>;
  let driverUser: InstanceType<typeof User>;
  let nonParticipantUser: InstanceType<typeof User>;
  let adminUser: InstanceType<typeof User>;
  let testDelivery: InstanceType<typeof Delivery>;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    await User.deleteMany({});
    await Delivery.deleteMany({});
    await ChatMessage.deleteMany({});

    senderUser = await createUser(UserRole.ENTERPRISE, 'sender');
    recipientUser = await createUser(UserRole.USER, 'recipient');
    driverUser = await createUser(UserRole.DRIVER, 'driver');
    nonParticipantUser = await createUser(UserRole.USER, 'stranger');
    adminUser = await createUser(UserRole.ADMIN, 'admin');

    testDelivery = await Delivery.create({
      trackingNumber: `TRK-${Date.now()}`,
      sender: senderUser._id,
      recipient: recipientUser._id,
      driverId: driverUser._id.toString(),
      userId: senderUser._id.toString(),
      status: DeliveryStatus.IN_PROGRESS,
      pickupCoordinates: { lat: 10, lng: 20, address: 'Pickup Address' },
      dropoffCoordinates: { lat: 11, lng: 21, address: 'Dropoff Address' },
    });
  });

  describe('REST Endpoints - Access Control & Validation', () => {
    it('returns 401 when unauthenticated', async () => {
      const res = await request(app).get(`/api/v1/deliveries/${testDelivery._id}/messages`);
      expect(res.status).toBe(401);
    });

    it('returns 400 when delivery ID is invalid', async () => {
      const token = signToken(senderUser._id.toString());
      const res = await request(app)
        .get('/api/v1/deliveries/invalid-id/messages')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
    });

    it('returns 404 when delivery does not exist', async () => {
      const token = signToken(senderUser._id.toString());
      const nonExistentId = new Types.ObjectId().toString();
      const res = await request(app)
        .get(`/api/v1/deliveries/${nonExistentId}/messages`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(404);
    });

    it('returns 403 when requesting user is not a participant', async () => {
      const token = signToken(nonParticipantUser._id.toString());
      const res = await request(app)
        .get(`/api/v1/deliveries/${testDelivery._id}/messages`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(res.body.message).toContain('Access denied');
    });

    it('allows access for sender, recipient, driver, and admin', async () => {
      for (const user of [senderUser, recipientUser, driverUser, adminUser]) {
        const token = signToken(user._id.toString());
        const res = await request(app)
          .get(`/api/v1/deliveries/${testDelivery._id}/messages`)
          .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
      }
    });
  });

  describe('REST Endpoints - Paginated History', () => {
    beforeEach(async () => {
      // Seed 5 messages with sequential timestamps
      for (let i = 1; i <= 5; i++) {
        await ChatMessage.create({
          deliveryId: testDelivery._id,
          content: `Message ${i}`,
          sender: senderUser._id.toString(),
          recipients: [recipientUser._id, driverUser._id],
          readBy: [{ userId: senderUser._id, readAt: new Date() }],
          createdAt: new Date(Date.now() + i * 1000),
        });
      }
    });

    it('paginates delivery messages with limit and page', async () => {
      const token = signToken(recipientUser._id.toString());
      const res = await request(app)
        .get(`/api/v1/deliveries/${testDelivery._id}/messages?page=1&limit=2`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.data).toHaveLength(2);
      expect(res.body.data.total).toBe(5);
      expect(res.body.data.page).toBe(1);
      expect(res.body.data.limit).toBe(2);
      expect(res.body.data.totalPages).toBe(3);

      // Newest messages first
      expect(res.body.data.data[0].content).toBe('Message 5');
      expect(res.body.data.data[1].content).toBe('Message 4');
    });

    it('returns page 2 of messages', async () => {
      const token = signToken(driverUser._id.toString());
      const res = await request(app)
        .get(`/api/v1/deliveries/${testDelivery._id}/messages?page=2&limit=2`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.data).toHaveLength(2);
      expect(res.body.data.data[0].content).toBe('Message 3');
      expect(res.body.data.data[1].content).toBe('Message 2');
    });
  });

  describe('Unread Counts and Transitions (mark-read)', () => {
    it('computes unread counts correctly and transitions on mark-read', async () => {
      // 1. Driver sends a message to the delivery
      await ChatMessage.create({
        deliveryId: testDelivery._id,
        content: 'I have arrived at pickup location',
        sender: driverUser._id.toString(),
        recipients: [senderUser._id, recipientUser._id],
        readBy: [{ userId: driverUser._id, readAt: new Date() }],
      });

      // 2. Sender sends a reply message
      await ChatMessage.create({
        deliveryId: testDelivery._id,
        content: 'Package is handed over to you',
        sender: senderUser._id.toString(),
        recipients: [driverUser._id, recipientUser._id],
        readBy: [{ userId: senderUser._id, readAt: new Date() }],
      });

      // Check unread count for driver:
      // Driver sent 1 message (already read), sender sent 1 message (unread for driver) => 1 unread
      const driverToken = signToken(driverUser._id.toString());
      const driverUnreadRes = await request(app)
        .get(`/api/v1/deliveries/${testDelivery._id}/messages/unread`)
        .set('Authorization', `Bearer ${driverToken}`);

      expect(driverUnreadRes.status).toBe(200);
      expect(driverUnreadRes.body.data.unreadCount).toBe(1);

      // Check unread count for recipient:
      // Recipient has not sent any message and hasn't read yet => 2 unread
      const recipientToken = signToken(recipientUser._id.toString());
      const recipientUnreadRes = await request(app)
        .get(`/api/v1/deliveries/${testDelivery._id}/messages/unread`)
        .set('Authorization', `Bearer ${recipientToken}`);

      expect(recipientUnreadRes.status).toBe(200);
      expect(recipientUnreadRes.body.data.unreadCount).toBe(2);

      // Check unread count for sender:
      // Sender sent 1 message (read), driver sent 1 message (unread) => 1 unread
      const senderToken = signToken(senderUser._id.toString());
      const senderUnreadRes = await request(app)
        .get(`/api/v1/deliveries/${testDelivery._id}/messages/unread`)
        .set('Authorization', `Bearer ${senderToken}`);

      expect(senderUnreadRes.status).toBe(200);
      expect(senderUnreadRes.body.data.unreadCount).toBe(1);

      // Recipient marks messages as read via PATCH /read
      const markReadRes = await request(app)
        .patch(`/api/v1/deliveries/${testDelivery._id}/messages/read`)
        .set('Authorization', `Bearer ${recipientToken}`);

      expect(markReadRes.status).toBe(200);
      expect(markReadRes.body.data.modifiedCount).toBe(2);

      // Verify recipient unread count is now 0
      const recipientAfterReadRes = await request(app)
        .get(`/api/v1/deliveries/${testDelivery._id}/messages/unread`)
        .set('Authorization', `Bearer ${recipientToken}`);

      expect(recipientAfterReadRes.body.data.unreadCount).toBe(0);

      // Driver's unread count is still 1 (unaffected)
      const driverCheckRes = await request(app)
        .get(`/api/v1/deliveries/${testDelivery._id}/messages/unread`)
        .set('Authorization', `Bearer ${driverToken}`);
      expect(driverCheckRes.body.data.unreadCount).toBe(1);

      // Driver marks read via PATCH /mark-read alias
      const driverMarkRes = await request(app)
        .patch(`/api/v1/deliveries/${testDelivery._id}/messages/mark-read`)
        .set('Authorization', `Bearer ${driverToken}`);
      expect(driverMarkRes.status).toBe(200);
      expect(driverMarkRes.body.data.modifiedCount).toBe(1);

      // Now driver unread is 0
      const driverFinalUnread = await request(app)
        .get(`/api/v1/deliveries/${testDelivery._id}/messages/unread`)
        .set('Authorization', `Bearer ${driverToken}`);
      expect(driverFinalUnread.body.data.unreadCount).toBe(0);
    });
  });

  describe('Socket Transport & Delivery-Scoped Rooms', () => {
    it('persists message with deliveryId, recipients, and readBy via ChatMessageService', async () => {
      const payload = {
        deliveryId: testDelivery._id.toString(),
        content: 'Driver approaching dropoff',
        sender: driverUser._id.toString(),
      };

      const message = await chatMessageService.createMessage(payload);

      expect(message._id).toBeDefined();
      expect(message.deliveryId?.toString()).toBe(testDelivery._id.toString());
      expect(message.content).toBe('Driver approaching dropoff');
      expect(message.sender).toBe(driverUser._id.toString());

      // Auto-inferred recipients should include sender and recipient (excluding driver)
      expect(message.recipients.map((r) => r.toString())).toContain(senderUser._id.toString());
      expect(message.recipients.map((r) => r.toString())).toContain(recipientUser._id.toString());

      // readBy contains driver with timestamp
      expect(message.readBy).toHaveLength(1);
      expect(message.readBy[0].userId.toString()).toBe(driverUser._id.toString());
      expect(message.readBy[0].readAt).toBeDefined();
    });

    it('broadcasts delivery-scoped message to delivery rooms in SocketService', async () => {
      const mockToEmitter = {
        to: jest.fn().mockReturnThis(),
        emit: jest.fn(),
      };
      const mockNamespace = {
        to: jest.fn().mockReturnValue(mockToEmitter),
        emit: jest.fn(),
      };

      const payload = {
        deliveryId: testDelivery._id.toString(),
        content: 'Hello in delivery room',
        sender: senderUser._id.toString(),
      };

      await socketService.handleIncomingMessage(mockNamespace as never, payload);

      const expectedRoom = deliveryRoom(testDelivery._id.toString());
      expect(mockNamespace.to).toHaveBeenCalledWith(expectedRoom);
      expect(mockToEmitter.to).toHaveBeenCalledWith(testDelivery._id.toString());
      expect(mockToEmitter.emit).toHaveBeenCalledWith(
        'message',
        expect.objectContaining({
          content: 'Hello in delivery room',
          deliveryId: testDelivery._id,
        }),
      );
    });

    it('multi-participant end-to-end flow: socket message -> REST unread count -> mark read', async () => {
      // 1. Driver sends message via socket service
      await socketService.handleIncomingMessage({ emit: jest.fn() } as never, {
        deliveryId: testDelivery._id.toString(),
        content: 'Delivery en route',
        sender: driverUser._id.toString(),
      });

      // 2. Recipient checks unread count via REST
      const token = signToken(recipientUser._id.toString());
      const unreadRes = await request(app)
        .get(`/api/v1/deliveries/${testDelivery._id}/messages/unread`)
        .set('Authorization', `Bearer ${token}`);

      expect(unreadRes.status).toBe(200);
      expect(unreadRes.body.data.unreadCount).toBe(1);

      // 3. Recipient reads history via REST
      const historyRes = await request(app)
        .get(`/api/v1/deliveries/${testDelivery._id}/messages`)
        .set('Authorization', `Bearer ${token}`);

      expect(historyRes.status).toBe(200);
      expect(historyRes.body.data.data).toHaveLength(1);
      expect(historyRes.body.data.data[0].content).toBe('Delivery en route');

      // 4. Recipient marks as read
      const markRes = await request(app)
        .patch(`/api/v1/deliveries/${testDelivery._id}/messages/read`)
        .set('Authorization', `Bearer ${token}`);

      expect(markRes.status).toBe(200);
      expect(markRes.body.data.modifiedCount).toBe(1);

      // 5. Unread count drops to 0
      const finalUnreadRes = await request(app)
        .get(`/api/v1/deliveries/${testDelivery._id}/messages/unread`)
        .set('Authorization', `Bearer ${token}`);

      expect(finalUnreadRes.body.data.unreadCount).toBe(0);
    });
  });
});
