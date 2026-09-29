import { Delivery, DeliveryStatus } from '../models/Delivery';
import { routingService, ETARequest } from './routingService';
import QRCode from 'qrcode';
import { generateQrToken } from '../utils/qrToken';

interface DeliveryETARequest {
  deliveryId: string;
}

interface DeliveryETAResponse {
  deliveryId: string;
  status: string;
  pickup: {
    address: string;
    coordinates: { lat: number; lng: number };
  };
  dropoff: {
    address: string;
    coordinates: { lat: number; lng: number };
  };
  eta: {
    estimatedMinutes: number;
    distanceKm: number;
    durationText: string;
    distanceText: string;
  };
}

class DeliveryService {
  async calculateDeliveryETA(request: DeliveryETARequest): Promise<DeliveryETAResponse> {
    const delivery = await Delivery.findOne({ deliveryId: request.deliveryId });

    if (!delivery) {
      throw new Error(`Delivery with ID ${request.deliveryId} not found`);
    }

    if (!delivery.pickupCoordinates || !delivery.dropoffCoordinates) {
      throw new Error('Delivery does not have complete coordinates');
    }

    const routingRequest: ETARequest = {
      pickup: {
        lat: delivery.pickupCoordinates.lat,
        lng: delivery.pickupCoordinates.lng,
      },
      dropoff: {
        lat: delivery.dropoffCoordinates.lat,
        lng: delivery.dropoffCoordinates.lng,
      },
      travelMode: 'driving',
    };

    const etaResult = await routingService.calculateETA(routingRequest);

    delivery.distance = etaResult.distance * 1000;
    delivery.estimatedDuration = etaResult.estimatedTime * 60;
    await delivery.save();

    return {
      deliveryId: delivery.deliveryId,
      status: delivery.status,
      pickup: {
        address: delivery.pickupCoordinates.address,
        coordinates: {
          lat: delivery.pickupCoordinates.lat,
          lng: delivery.pickupCoordinates.lng,
        },
      },
      dropoff: {
        address: delivery.dropoffCoordinates.address,
        coordinates: {
          lat: delivery.dropoffCoordinates.lat,
          lng: delivery.dropoffCoordinates.lng,
        },
      },
      eta: {
        estimatedMinutes: etaResult.estimatedTime,
        distanceKm: etaResult.distance,
        durationText: etaResult.durationText,
        distanceText: etaResult.distanceText,
      },
    };
  }

  /**
   * Generates a QR code for delivery handoff verification.
   *
   * Retrieves delivery from MongoDB, generates a signed token,
   * and returns a base64-encoded QR code image.
   *
   * @param deliveryId - MongoDB delivery document ID
   * @returns Base64-encoded QR code PNG image
   * @throws 404 if delivery not found
   * @throws 400 if delivery not in a handoff-eligible status
   */
  async generateHandoffQrCode(deliveryId: string): Promise<{
    qrCode: string; // base64 data URL
    token: string; // verification token (for logging/audit)
    expiresAt: Date; // token expiry time
    deliveryId: string;
  }> {
    // Load delivery from MongoDB (no hardcoded data)
    const delivery = await Delivery.findById(deliveryId).lean();

    if (!delivery) {
      const err = new Error('Delivery not found');
      (err as any).statusCode = 404;
      throw err;
    }

    // Validate delivery is in a handoff-eligible status
    // Use EXACT status values from Delivery schema
    const eligibleStatuses = [DeliveryStatus.IN_PROGRESS];
    if (!eligibleStatuses.includes(delivery.status as DeliveryStatus)) {
      const err = new Error(
        `Delivery is not eligible for handoff. Current status: ${delivery.status}`,
      );
      (err as any).statusCode = 400;
      throw err;
    }

    // Generate secure token
    const token = generateQrToken(deliveryId);
    const expiryMinutes = parseInt(process.env.QR_TOKEN_EXPIRY_MINUTES ?? '30', 10);
    const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000);

    // QR code encodes: delivery ID + verification token
    const qrData = JSON.stringify({
      deliveryId,
      token,
      type: 'swiftchain_handoff',
    });

    // Generate base64 QR code image
    const qrCode = await QRCode.toDataURL(qrData, {
      type: 'image/png',
      width: 300,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#FFFFFF',
      },
    });

    return { qrCode, token, expiresAt, deliveryId };
  }
}

export const deliveryService = new DeliveryService();
