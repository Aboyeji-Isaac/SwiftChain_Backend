import mongoose from 'mongoose';
import env from './config/env';
import { Delivery } from './models/Delivery';

const MONGODB_URI = env.MONGODB_URI;

const seedDeliveries = async (): Promise<void> => {
  try {
    await mongoose.connect(MONGODB_URI);

    const delivery = {
      deliveryId: 'DEL-001',
      driverId: 'DRV-001',
      userId: 'USR-001',
      pickupCoordinates: {
        lat: 40.7128,
        lng: -74.006,
        address: 'New York, NY',
      },
      dropoffCoordinates: {
        lat: 40.758,
        lng: -73.9855,
        address: 'Times Square, NY',
      },
      status: 'pending',
    };

    await Delivery.deleteMany({});
    await Delivery.create(delivery);

    // eslint-disable-next-line no-console
    console.log('✅ Test delivery created successfully');
    process.exit(0);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('❌ Failed to seed data:', error);
    process.exit(1);
  }
};

seedDeliveries();
