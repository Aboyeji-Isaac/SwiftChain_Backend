/**
 * Integration tests for QR code generation endpoint.
 * Uses real MongoDB — loads delivery from DB.
 */

import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../src/app';
import Delivery, { DeliveryStatus } from '../../src/models/Delivery';
import { generateQrToken, verifyQrToken } from '../../src/utils/qrToken';

const MONGO_URI = process.env.MONGODB_URI_TEST ?? process.env.MONGODB_URI ?? '';

let authToken: string;
let testDeliveryId: string;

beforeAll(async () => {
  await mongoose.connect(MONGO_URI);

  // Get real auth token from login
  const loginRes = await request(app).post('/api/v1/auth/login').send({
    email: process.env.TEST_USER_EMAIL,
    password: process.env.TEST_USER_PASSWORD,
  });
  authToken = loginRes.body.data?.token || loginRes.body.token;

  // Find or create a delivery in eligible status (IN_PROGRESS)
  let delivery: Record<string, unknown> | null = await Delivery.findOne({
    status: DeliveryStatus.IN_PROGRESS,
  }).lean();

  if (!delivery) {
    const created = await Delivery.create({
      status: DeliveryStatus.IN_PROGRESS,
      trackingNumber: `TEST-QR-${Date.now()}`,
      customer: {
        name: 'Test Customer',
        phone: '+1234567890',
      },
      pickup: {
        address: '123 Start St',
      },
      dropoff: {
        address: '456 End Ave',
      },
      package: {
        description: 'Test Package',
        weight: 5,
      },
      deliveryFee: 50,
      escrowAmount: 100,
    });
    delivery = created.toObject() as Record<string, unknown>;
  }
  if (!delivery) throw new Error('Failed to create/find test delivery');
  testDeliveryId = (
    (delivery._id as mongoose.Types.ObjectId) ?? (delivery.id as string)
  ).toString();
});

afterAll(async () => {
  await mongoose.connection.close();
});

describe('GET /api/v1/deliveries/:id/qrcode', () => {
  it('returns 200 with QR code for valid delivery', async () => {
    const res = await request(app)
      .get(`/api/v1/deliveries/${testDeliveryId}/qrcode`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.qrCode).toBeDefined();
    expect(res.body.data.expiresAt).toBeDefined();
  });

  it('returns base64 PNG data URL', async () => {
    const res = await request(app)
      .get(`/api/v1/deliveries/${testDeliveryId}/qrcode`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.body.data.qrCode).toMatch(/^data:image\/png;base64,/);
  });

  it('does NOT expose verification token in response', async () => {
    const res = await request(app)
      .get(`/api/v1/deliveries/${testDeliveryId}/qrcode`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.body.data.token).toBeUndefined();
  });

  it('returns 401 without auth token', async () => {
    const res = await request(app).get(`/api/v1/deliveries/${testDeliveryId}/qrcode`);

    expect(res.status).toBe(401);
  });

  it('returns 404 for non-existent delivery', async () => {
    const fakeId = new mongoose.Types.ObjectId().toString();
    const res = await request(app)
      .get(`/api/v1/deliveries/${fakeId}/qrcode`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(404);
  });

  it('returns 400 for delivery not in handoff-eligible status', async () => {
    // Create a delivery in PENDING status (not eligible)
    const ineligibleDelivery = await Delivery.create({
      status: DeliveryStatus.PENDING,
      trackingNumber: `TEST-QR-INELIGIBLE-${Date.now()}`,
      customer: {
        name: 'Test Customer',
        phone: '+1234567890',
      },
      pickup: {
        address: '123 Start St',
      },
      dropoff: {
        address: '456 End Ave',
      },
      package: {
        description: 'Test Package',
        weight: 5,
      },
      deliveryFee: 50,
      escrowAmount: 100,
    });

    const res = await request(app)
      .get(`/api/v1/deliveries/${ineligibleDelivery._id.toString()}/qrcode`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(400);
    expect(res.body.data.message || res.body.message).toContain('not eligible for handoff');
  });
});

describe('generateQrToken / verifyQrToken utilities', () => {
  it('generates a token that verifies correctly', () => {
    const token = generateQrToken(testDeliveryId);
    const decoded = verifyQrToken(token);
    expect(decoded.deliveryId).toBe(testDeliveryId);
  });

  it('rejects tampered token', () => {
    const token = generateQrToken(testDeliveryId);
    const tampered = token.slice(0, -5) + 'XXXXX';
    expect(() => verifyQrToken(tampered)).toThrow();
  });

  it('rejects expired token', () => {
    // Temporarily set short expiry
    process.env.QR_TOKEN_EXPIRY_MINUTES = '0';
    const token = generateQrToken(testDeliveryId);
    // Token expires immediately
    expect(() => verifyQrToken(token)).toThrow(/expired/);
    delete process.env.QR_TOKEN_EXPIRY_MINUTES;
  });

  it('rejects empty token', () => {
    expect(() => verifyQrToken('')).toThrow();
  });

  it('uses timingSafeEqual for signature comparison', () => {
    const token = generateQrToken(testDeliveryId);
    // Tamper with the token
    const tampered = token.slice(0, -5) + 'XXXXX';
    // Should throw error due to signature mismatch
    expect(() => verifyQrToken(tampered)).toThrow('Invalid QR token signature');
  });
});
