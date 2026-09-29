#!/usr/bin/env ts-node
/**
 * Seeding script optimized for 10,000 concurrent Socket.IO load test.
 *
 * Creates:
 *   - 10,000 driver accounts (one per concurrent VU)
 *   - 5,000 delivery documents (reused across drivers in round-robin)
 *
 * Usage:
 *   LOAD_TEST_MONGODB_URI=mongodb://... npm run seed:10k
 *
 * Or pass as environment variables:
 *   LOAD_TEST_DRIVER_COUNT=10000 \
 *   LOAD_TEST_DELIVERY_COUNT=5000 \
 *   LOAD_TEST_MONGODB_URI=mongodb://... \
 *   ts-node scripts/seedLoadTestData10k.ts
 *
 * Expected runtime: ~30-60 seconds depending on MongoDB latency.
 *
 * Note: This creates a large volume of test data. Ensure sufficient disk space
 * and that the MongoDB instance is configured with adequate memory.
 */

import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import User from '../../src/models/User';
import { Delivery, DeliveryStatus } from '../../src/models/Delivery';
import { UserRole } from '../../src/interfaces/IUser';

dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

const MONGODB_URI =
  process.env.LOAD_TEST_MONGODB_URI ||
  process.env.MONGODB_URI ||
  'mongodb://localhost:27017/swiftchain';

// For 10k test: create 10,000 drivers (one per VU), reuse 5,000 deliveries
const DRIVER_COUNT = parseInt(process.env.LOAD_TEST_DRIVER_COUNT || '10000', 10);
const CUSTOMER_COUNT = parseInt(process.env.LOAD_TEST_CUSTOMER_COUNT || '100', 10);
const DELIVERY_COUNT = parseInt(process.env.LOAD_TEST_DELIVERY_COUNT || '5000', 10);
const SHARED_PASSWORD = process.env.LOAD_TEST_USER_PASSWORD || 'LoadTest#12345';

const OUTPUT_DIR = path.resolve(__dirname, '../.tmp');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'seed-output.json');

const EMAIL_PATTERN = /^loadtest\.(driver|customer)\./;

interface SeededAccount {
  id: string;
  email: string;
}

interface SeededDelivery {
  id: string;
}

/**
 * Batch insert with progress reporting.
 *
 * @param Model - Mongoose model to insert into
 * @param documents - Array of documents to insert
 * @param batchSize - Documents per batch
 * @param label - Label for progress reporting
 */
async function batchInsert(
  Model: any,
  documents: any[],
  batchSize: number,
  label: string,
): Promise<any[]> {
  const results: any[] = [];
  const totalBatches = Math.ceil(documents.length / batchSize);

  for (let i = 0; i < documents.length; i += batchSize) {
    const batch = documents.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;

    try {
      const inserted = await Model.insertMany(batch, { ordered: false });
      results.push(...inserted);

      const progress = Math.min(i + batchSize, documents.length);
      process.stdout.write(
        `\r${label}: ${progress}/${documents.length} (batch ${batchNum}/${totalBatches})`,
      );
    } catch (err: any) {
      // insertMany with ordered: false throws on duplicate keys, but continues
      // with inserted items. Extract them from the error.
      if (err.insertedDocs) {
        results.push(...err.insertedDocs);
      }
      const progress = Math.min(i + batchSize, documents.length);
      process.stdout.write(
        `\r${label}: ${progress}/${documents.length} (batch ${batchNum}/${totalBatches}, partial)`,
      );
    }
  }

  console.log(''); // Newline after progress
  return results;
}

/**
 * Model-layer seeding: writes real documents into MongoDB through the
 * application's own Mongoose models (User, Delivery).
 *
 * Optimized for large fixture counts with batch insertion and progress reporting.
 */
async function seed(): Promise<void> {
  await mongoose.connect(MONGODB_URI);
  // eslint-disable-next-line no-console
  console.log(`Connected to ${MONGODB_URI}`);
  // eslint-disable-next-line no-console
  console.log(`Seeding ${DRIVER_COUNT} drivers, ${DELIVERY_COUNT} deliveries...`);

  // Remove fixtures from previous runs to keep seeding idempotent
  // eslint-disable-next-line no-console
  console.log('Cleaning up old load test fixtures...');
  await User.deleteMany({ email: EMAIL_PATTERN });
  await Delivery.deleteMany({ isLoadTestFixture: true });

  // Batch size for insertMany (balance between memory and DB roundtrips)
  const BATCH_SIZE = 500;

  // ─── Seed Drivers ─────────────────────────────────────────────────────────
  // eslint-disable-next-line no-console
  console.log(`\nSeeding ${DRIVER_COUNT} drivers...`);
  const driverDocs = Array.from({ length: DRIVER_COUNT }, (_, i) => ({
    email: `loadtest.driver.${i}@swiftchain.test`,
    password: SHARED_PASSWORD,
    firstName: 'LoadDriver',
    lastName: `${i}`,
    role: UserRole.DRIVER,
    isActive: true,
  }));

  const drivers: SeededAccount[] = [];
  const insertedDrivers = await batchInsert(User, driverDocs, BATCH_SIZE, 'Drivers');
  drivers.push(
    ...insertedDrivers.map((u) => ({
      id: String(u._id),
      email: u.email,
    })),
  );
  // eslint-disable-next-line no-console
  console.log(`✓ Seeded ${drivers.length} drivers`);

  // ─── Seed Customers ───────────────────────────────────────────────────────
  // eslint-disable-next-line no-console
  console.log(`\nSeeding ${CUSTOMER_COUNT} customers...`);
  const customerDocs = Array.from({ length: CUSTOMER_COUNT }, (_, i) => ({
    email: `loadtest.customer.${i}@swiftchain.test`,
    password: SHARED_PASSWORD,
    firstName: 'LoadCustomer',
    lastName: `${i}`,
    role: UserRole.USER,
    isActive: true,
  }));

  const customers: SeededAccount[] = [];
  const insertedCustomers = await batchInsert(User, customerDocs, BATCH_SIZE, 'Customers');
  customers.push(
    ...insertedCustomers.map((u) => ({
      id: String(u._id),
      email: u.email,
    })),
  );
  // eslint-disable-next-line no-console
  console.log(`✓ Seeded ${customers.length} customers`);

  // ─── Seed Deliveries ──────────────────────────────────────────────────────
  // eslint-disable-next-line no-console
  console.log(`\nSeeding ${DELIVERY_COUNT} deliveries...`);
  const deliveryDocs = Array.from({ length: DELIVERY_COUNT }, (_, i) => {
    const driver = drivers[i % drivers.length];
    const customer = customers[i % customers.length];

    return {
      deliveryId: `LOADTEST-${Date.now()}-${i}`,
      driverId: driver.id,
      userId: customer.id,
      isLoadTestFixture: true,
      customer: {
        name: `Load Customer ${i}`,
        phone: '+10000000000',
      },
      pickup: {
        address: `${100 + (i % 10000)} Load Test Ave`,
        city: 'Testville',
      },
      dropoff: {
        address: `${200 + (i % 10000)} Load Test Ave`,
        city: 'Testville',
      },
      package: {
        description: 'Load test package',
        weight: 1 + (i % 10),
      },
      pickupCoordinates: {
        lat: 40.7128 + (i % 100) * 0.01,
        lng: -74.006 + (i % 100) * 0.01,
        address: `${100 + (i % 10000)} Load Test Ave`,
      },
      dropoffCoordinates: {
        lat: 40.758 + (i % 100) * 0.01,
        lng: -73.9855 + (i % 100) * 0.01,
        address: `${200 + (i % 10000)} Load Test Ave`,
      },
      status: DeliveryStatus.ASSIGNED,
    };
  });

  const deliveries: SeededDelivery[] = [];
  const insertedDeliveries = await batchInsert(Delivery, deliveryDocs, BATCH_SIZE, 'Deliveries');
  deliveries.push(
    ...insertedDeliveries.map((d) => ({
      id: String(d._id),
    })),
  );
  // eslint-disable-next-line no-console
  console.log(`✓ Seeded ${deliveries.length} deliveries`);

  // ─── Write Fixtures File ──────────────────────────────────────────────────
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(
    OUTPUT_FILE,
    JSON.stringify({ password: SHARED_PASSWORD, drivers, customers, deliveries }, null, 2),
  );

  // eslint-disable-next-line no-console
  console.log(`\n✓ Fixtures written to ${OUTPUT_FILE}`);
  // eslint-disable-next-line no-console
  console.log(`\nSummary:`);
  // eslint-disable-next-line no-console
  console.log(`  Drivers:    ${drivers.length}`);
  // eslint-disable-next-line no-console
  console.log(`  Customers:  ${customers.length}`);
  // eslint-disable-next-line no-console
  console.log(`  Deliveries: ${deliveries.length}`);

  await mongoose.disconnect();
}

seed().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('\nFailed to seed load test data:', error);
  process.exitCode = 1;
});
