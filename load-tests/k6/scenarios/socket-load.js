/**
 * Socket.IO Load Test — k6 Scenario
 *
 * Issue #112: Create load tests for Socket.io to ensure handling of 10,000 concurrent updates.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * OVERVIEW
 * ────────────────────────────────────────────────────────────────────────────
 *
 * This scenario simulates up to 10,000 concurrent driver connections against the
 * SwiftChain Socket.IO real-time gateway at `/api/v1/realtime`. Each virtual
 * user (VU) represents a driver that:
 *
 *   1. Authenticates via REST login to obtain a JWT
 *   2. Connects to the Socket.IO namespace
 *   3. Periodically sends driver_location_update events (lat/lng payloads)
 *   4. Receives location_update_ack confirmations
 *   5. Disconnects after a sustained load period
 *
 * The test ramps up gradually to avoid thundering herd, holds at full load for
 * a soak period, then ramps down cleanly.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * RUNNING THE TEST
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Prerequisites:
 *   - Backend running: npm run dev (from repo root)
 *   - MongoDB instance connected
 *   - k6 installed locally
 *   - Load test fixtures seeded
 *
 * Setup (one time):
 *   cd load-tests
 *   npm install
 *   cp .env.example .env
 *   npm run seed          # for default 25/25/50 fixtures
 *   # or
 *   npm run seed:10k      # for 10k drivers / 5k deliveries
 *
 * Run the test:
 *   npm run test:socket        # standard ramp (uses defaults from config)
 *   npm run test:socket:10k    # optimized for 10k concurrent
 *
 * Or directly:
 *   k6 run k6/scenarios/socket-load.js
 *   k6 run -e SOCKET_LOAD_EMIT_INTERVAL_MS=3500 k6/scenarios/socket-load.js
 *
 * Via Docker:
 *   docker run --rm -i --network=host \
 *     -v "$PWD/k6:/scripts" \
 *     grafana/k6 run /scripts/scenarios/socket-load.js
 *
 * ────────────────────────────────────────────────────────────────────────────
 * INTERPRETING OUTPUT
 * ────────────────────────────────────────────────────────────────────────────
 *
 * k6 Output Summary:
 *
 *   checks ................: 97.8% ✓ 39120 ✗ 872
 *     → Percentage of custom assertions that passed (connection, auth, updates sent)
 *     → Ideally >95%. If <90%, increase backend resources or reduce VU count.
 *
 *   ws_sessions ..........: 10000 avg=10000
 *     → Total concurrent WebSocket sessions established
 *     → Should match or closely approximate your target VU count
 *
 *   ws_message_sent ......: 45000
 *     → Total location_update messages sent across all VUs
 *     → Expected: VUs × (duration_sec / emit_interval_sec)
 *       e.g. 10,000 VUs × (240s / 3.5s) ≈ 685,000 messages
 *
 *   ws_message_received ..: 45000
 *     → Total messages received (acks, broadcasts)
 *     → Should be ≥ messages sent (often higher due to broadcast receive)
 *
 *   ws_session_duration ..: avg=174.23s min=2.34s med=180.12s max=240.04s
 *     → How long each WebSocket connection stayed alive
 *     → min/max show early disconnects vs. normal lifetime
 *     → Variance indicates potential instability or network issues
 *
 * Server Metrics (printed in teardown):
 *
 *   Connected Sockets: 42
 *     → Sockets still connected when metrics were fetched (usually minimal post-test)
 *     → During test, should approach total VU count
 *
 *   Total Connections: 10000
 *     → Cumulative connections since server start
 *     → Should match requested VUs
 *
 *   Messages Processed: 45000
 *     → Server-side count of location_update events processed
 *     → Should align with ws_message_sent
 *
 *   Latency Percentiles (milliseconds):
 *     p50:   12.34 ms  ← 50% of messages < this latency (typical: 10-50ms)
 *     p95:   87.23 ms  ← 95% of messages < this latency (SLA: <500ms)
 *     p99:  156.78 ms  ← 99% of messages < this latency (SLA: <1000ms)
 *     → Latencies are round-trip: emit → server receives → processes → acks
 *     → If latencies exceed SLA, check database/network/CPU utilization
 *
 *   Memory Usage (MB):
 *     Heap Used:       256.42 MB  ← Current heap allocation
 *     Heap Total:      512.00 MB  ← Total heap available
 *     RSS:             768.15 MB  ← Physical memory consumed by process
 *     External:          4.20 MB  ← C++ addon/buffer memory
 *     → Monitor growth across test duration for memory leaks
 *     → RSS approaching system limits indicates vertical scaling needed
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THRESHOLDS & PASS/FAIL
 * ────────────────────────────────────────────────────────────────────────────
 *
 * k6 exits with code 0 (success) if all thresholds pass:
 *
 *   ws_connecting_total rate < 5%     → Allow up to 5% connection failures
 *   ws_sending_total rate < 2%        → Allow up to 2% message send failures
 *   checks rate > 90%                 → At least 90% of custom checks pass
 *
 * If any threshold fails, k6 exits with code 1 (failure).
 *
 * ────────────────────────────────────────────────────────────────────────────
 * RAMP PROFILE
 * ────────────────────────────────────────────────────────────────────────────
 *
 * The test follows a staged ramp to avoid overwhelming the server:
 *
 *   Stage 1: 0   → 2,500 VUs over 30s   (83 VUs/s join rate)
 *   Stage 2: 2.5k → 5,000 VUs over 30s  (83 VUs/s join rate)
 *   Stage 3: 5k → 10,000 VUs over 60s   (83 VUs/s join rate)
 *   Stage 4: Hold 10,000 VUs for 60s    (soak period)
 *   Stage 5: 10k → 0 VUs over 30s       (clean shutdown)
 *
 * Total duration: ~210 seconds (~3.5 minutes)
 *
 * ────────────────────────────────────────────────────────────────────────────
 * DEBUGGING & TROUBLESHOOTING
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Connection failures (ws_connecting_total rate > 5%):
 *   → Check backend logs for auth/handshake errors
 *   → Verify LOAD_TEST_BASE_URL is accessible
 *   → Check Socket.IO configuration (CORS, ping/pong timeouts)
 *   → Increase --vus-max if k6 is CPU-bound on client
 *
 * Message send failures (ws_sending_total rate > 2%):
 *   → Indicates server is rejecting or not acking messages
 *   → Check database connection pooling
 *   → Check for OOM kills or resource exhaustion on server
 *   → Monitor CPU, disk I/O, network saturation
 *
 * High latencies (p95 > 500ms, p99 > 1000ms):
 *   → Database query performance issue (check indexes)
 *   → Server CPU saturation (reduce VUs or scale vertically)
 *   → Network latency issue (check RTT with ping)
 *   → Memory pressure causing GC pauses
 *
 * Low checks rate (< 90%):
 *   → Some VUs fail to connect or send updates
 *   → Review ws_sessions count — does it match VUs?
 *   → Check server logs for specific error messages
 *
 * ────────────────────────────────────────────────────────────────────────────
 * IMPLEMENTATION NOTES
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Socket.IO Protocol:
 *   - This script uses raw WebSocket via k6/ws to connect to the Socket.IO
 *     namespace. Socket.IO layers its own protocol on top of WebSocket, so
 *     messages are wrapped in the format: 42[<event>,<payload>]
 *   - We emit payloads as JSON but unwrap acks manually in the message handler
 *
 * Metrics Endpoint:
 *   - During setup and teardown, we call GET /api/v1/socket-metrics
 *   - This endpoint collects connection/message/latency metrics server-side
 *   - Metrics are in-memory (rolling window of last 10k samples)
 *   - No external time-series database required
 *
 * Staggered Startup:
 *   - To avoid a thundering herd on the server, each VU sleeps for a
 *     calculated stagger duration based on (__VU / K6_VUS) * 5 seconds
 *   - This spreads connection startup over ~5s before the test begins
 */

import ws from 'k6/ws';
import { check, sleep, group } from 'k6';
import http from 'k6/http';
import { BASE_URL, API_PREFIX, fixtures, drivers, deliveries, SHARED_PASSWORD } from '../lib/config.js';
import { login, authHeaders } from '../lib/authClient.js';

/**
 * Load test for the Socket.IO WebSocket gateway:
 *   - Connect up to 10,000 concurrent virtual "driver" clients against
 *     the `/api/v1/realtime` namespace.
 *   - Each driver authenticates with a real JWT from the login endpoint.
 *   - Each driver emits periodic `driver_location_update` events with
 *     latitude/longitude payloads.
 *   - Capture message latency, connection success/error rate, and memory
 *     usage of the Node.js server process during the run.
 *
 * Ramp-up strategy:
 *   - Stage 1: 0 → 2,500 VUs over 30s (gentle start)
 *   - Stage 2: 2,500 → 5,000 VUs over 30s
 *   - Stage 3: 5,000 → 10,000 VUs over 60s
 *   - Stage 4: Hold at 10,000 VUs for 60s (soak)
 *   - Stage 5: 10,000 → 0 VUs over 30s (ramp-down)
 *
 * Total duration: ~210 seconds (~3.5 minutes)
 */

// ────────────────────────────────────────────────────────────────────────────
// CONFIGURATION
// ────────────────────────────────────────────────────────────────────────────

const BASE_SOCKET_URL = BASE_URL.replace(/^https?:\/\//, '');
const SOCKET_NAMESPACE = '/api/v1/realtime';

// Interval between location updates per VU (milliseconds)
const EMIT_INTERVAL_MS = __ENV.SOCKET_LOAD_EMIT_INTERVAL_MS
  ? parseInt(__ENV.SOCKET_LOAD_EMIT_INTERVAL_MS, 10)
  : 3500;

// Interval for polling server metrics during the test (milliseconds)
const METRICS_POLL_INTERVAL_MS = 5000;

export const options = {
  // Ramp stages: gradually scale up from 0 to 10,000 VUs
  stages: [
    { duration: '30s', target: 2500, name: 'Ramp 0→2.5k' },
    { duration: '30s', target: 5000, name: 'Ramp 2.5k→5k' },
    { duration: '60s', target: 10000, name: 'Ramp 5k→10k' },
    { duration: '60s', target: 10000, name: 'Soak @ 10k' },
    { duration: '30s', target: 0, name: 'Ramp 10k→0' },
  ],

  // Thresholds for success criteria
  // k6 will exit with non-zero status if any threshold is violated
  thresholds: {
    // Allow up to 5% connection failures (necessary for load edge cases)
    ws_connecting_total: ['rate<0.05'],
    // Allow up to 2% message send failures
    ws_sending_total: ['rate<0.02'],
    // Latency SLAs: p95 <500ms, p99 <1000ms
    // (These are measured by the server's metrics endpoint, not k6's built-in WS metrics)
    checks: ['rate>0.90'], // At least 90% of check assertions pass
  },

  // Extend timeout to allow slow connections in high load scenarios
  timeout: '30s',
  handshakeTimeout: '15s',
};

// ────────────────────────────────────────────────────────────────────────────
// HELPERS
// ────────────────────────────────────────────────────────────────────────────

/**
 * Fetch current Socket.IO metrics from the backend's /api/v1/socket-metrics endpoint.
 * Called periodically during the test to capture server-side performance data.
 */
function fetchSocketMetrics() {
  try {
    const res = http.get(`${API_PREFIX}/socket-metrics`);
    if (res.status === 200) {
      const data = res.json('data');
      return {
        success: true,
        connectedSockets: data.connectedSockets || 0,
        messagesProcessed: data.messagesProcessed || 0,
        messageLatencyMs: data.messageLatencyMs || {},
        memoryUsageBytes: data.memoryUsageBytes || {},
        timestamp: data.timestamp || '',
      };
    }
  } catch (err) {
    // Metrics endpoint may not be available in early stages; fail silently
  }
  return null;
}

/**
 * Simulate a single driver's WebSocket lifecycle:
 *   1. Authenticate via REST login endpoint
 *   2. Connect to Socket.IO WebSocket
 *   3. Join a delivery room
 *   4. Periodically emit location updates
 *   5. Track acks received
 *   6. Disconnect after duration
 */
function simulateDriver(driverIndex, durationMs) {
  const driver = drivers[driverIndex % drivers.length];
  const delivery = deliveries[driverIndex % deliveries.length];

  // Authenticate and get a JWT
  const token = login(driver.email, SHARED_PASSWORD);
  if (!token) {
    return {
      connected: false,
      authenticated: false,
      updatesSent: 0,
      acksReceived: 0,
      acksFailed: 0,
      errors: ['Failed to authenticate'],
      connectLatencyMs: null,
    };
  }

  const result = {
    connected: false,
    authenticated: true,
    updatesSent: 0,
    acksReceived: 0,
    acksFailed: 0,
    errors: [],
    connectLatencyMs: null,
    messageLatencies: [],
  };

  const connectStartedAt = Date.now();
  let updateCount = 0;
  let lastUpdateAt = Date.now();
  let metricsCheckAt = Date.now();

  try {
    // Connect to Socket.IO WebSocket
    const res = ws.connect(
      `ws://${BASE_SOCKET_URL}${SOCKET_NAMESPACE}?token=Bearer%20${encodeURIComponent(token)}`,
      {
        headers: {
          'Content-Type': 'application/json',
        },
        tags: { name: 'SocketIO_WebSocket' },
      },
      (socket) => {
        result.connectLatencyMs = Date.now() - connectStartedAt;
        result.connected = true;

        // Join the delivery room to receive broadcasts
        socket.send(JSON.stringify({ type: 'join_room', data: `delivery:${delivery.id}` }));

        // Set up periodic location updates
        const updateInterval = setInterval(() => {
          if (Date.now() - connectStartedAt > durationMs) {
            clearInterval(updateInterval);
            socket.close();
            return;
          }

          const payload = {
            deliveryId: delivery.id,
            lat: 40.7128 + (Math.random() - 0.5) * 0.1,
            lng: -74.006 + (Math.random() - 0.5) * 0.1,
            capturedAt: Date.now(),
          };

          socket.send(
            JSON.stringify({
              type: 'driver_location_update',
              data: payload,
            }),
          );
          result.updatesSent += 1;
          lastUpdateAt = Date.now();
        }, EMIT_INTERVAL_MS);

        // Listen for acks
        socket.on('message', (data) => {
          try {
            const msg = typeof data === 'string' ? JSON.parse(data) : data;

            if (msg.type === 'location_update_ack' || msg.type === '42[\"location_update_ack\",') {
              // Socket.IO wraps messages in 42[...] format; parse if needed
              let ack;
              if (typeof msg === 'string' && msg.startsWith('42')) {
                const payload = msg.slice(2);
                ack = JSON.parse(payload)[1];
              } else {
                ack = msg.data;
              }

              if (ack && ack.success) {
                result.acksReceived += 1;
              } else {
                result.acksFailed += 1;
                if (ack && ack.error) {
                  result.errors.push(`Ack error: ${ack.error}`);
                }
              }
            }
          } catch (parseErr) {
            // Ignore parse errors; k6's ws module may send non-JSON frames
          }
        });

        socket.on('close', () => {
          clearInterval(updateInterval);
        });

        socket.on('error', (err) => {
          result.errors.push(`WebSocket error: ${err}`);
        });

        // Hold the connection open for the full duration
        socket.setTimeout(() => {
          socket.close();
        }, durationMs);
      },
    );

    // Check for connection errors
    check(res, {
      'WebSocket connection successful': (r) => r && r.status === 101,
    });
  } catch (err) {
    result.errors.push(`Exception: ${err.message}`);
  }

  return result;
}

// ────────────────────────────────────────────────────────────────────────────
// MAIN TEST SCENARIO
// ────────────────────────────────────────────────────────────────────────────

/**
 * Main test function: each VU (virtual user) simulates a driver.
 * VUs are automatically spawned/destroyed according to the stages defined
 * in options.stages above.
 */
export default function () {
  const durationMs = 240_000; // Each VU's connection lasts ~4 minutes

  // Stagger VU startup to avoid thundering herd
  const staggerDelayMs = (__VU / Math.max(__ENV.K6_VUS || 10000, 1)) * 5000;
  sleep(staggerDelayMs / 1000);

  // Simulate this VU as a driver
  const result = simulateDriver(__VU - 1, durationMs);

  // Validate connection success
  check(result, {
    'Driver connected': (r) => r.connected === true,
    'Driver authenticated': (r) => r.authenticated === true,
    'Driver sent location updates': (r) => r.updatesSent > 0,
  });

  // Sleep for the connection duration to avoid rapid reconnects
  sleep(durationMs / 1000);
}

/**
 * Setup phase: run before any VUs start.
 * Fetch a snapshot of the metrics endpoint to verify it's available.
 */
export function setup() {
  group('Setup: Verify metrics endpoint', () => {
    const metricsRes = http.get(`${API_PREFIX}/socket-metrics`);
    check(metricsRes, {
      'Metrics endpoint available': (r) => r.status === 200,
    });
  });

  return { startTime: Date.now() };
}

/**
 * Teardown phase: run after all VUs finish.
 * Fetch final metrics snapshot and summarize.
 */
export function teardown(data) {
  group('Teardown: Fetch final metrics', () => {
    // Wait a moment for server to settle
    sleep(2);

    const metricsRes = http.get(`${API_PREFIX}/socket-metrics`);
    if (metricsRes.status === 200) {
      const metrics = metricsRes.json('data');
      const durationSec = (Date.now() - data.startTime) / 1000;

      // eslint-disable-next-line no-console
      console.log('\n╔════════════════════════════════════════════════════════════════╗');
      // eslint-disable-next-line no-console
      console.log('║        Socket.IO Load Test - Final Server Metrics             ║');
      // eslint-disable-next-line no-console
      console.log('╚════════════════════════════════════════════════════════════════╝');
      // eslint-disable-next-line no-console
      console.log(`Test Duration:            ${durationSec.toFixed(1)} seconds`);
      // eslint-disable-next-line no-console
      console.log(`\nConnection Metrics:`);
      // eslint-disable-next-line no-console
      console.log(`  Connected Sockets:      ${metrics.connectedSockets}`);
      // eslint-disable-next-line no-console
      console.log(`  Total Connections:      ${metrics.totalConnections}`);
      // eslint-disable-next-line no-console
      console.log(`  Total Disconnections:   ${metrics.totalDisconnections}`);
      // eslint-disable-next-line no-console
      console.log(`\nMessage Metrics:`);
      // eslint-disable-next-line no-console
      console.log(`  Messages Processed:     ${metrics.messagesProcessed}`);
      // eslint-disable-next-line no-console
      console.log(`\nLatency Percentiles (milliseconds):`);
      // eslint-disable-next-line no-console
      console.log(
        `  p50:                    ${metrics.messageLatencyMs.p50 ? metrics.messageLatencyMs.p50.toFixed(2) : 'N/A'} ms`,
      );
      // eslint-disable-next-line no-console
      console.log(
        `  p95:                    ${metrics.messageLatencyMs.p95 ? metrics.messageLatencyMs.p95.toFixed(2) : 'N/A'} ms`,
      );
      // eslint-disable-next-line no-console
      console.log(
        `  p99:                    ${metrics.messageLatencyMs.p99 ? metrics.messageLatencyMs.p99.toFixed(2) : 'N/A'} ms`,
      );
      // eslint-disable-next-line no-console
      console.log(`\nMemory Usage (MB):`);
      // eslint-disable-next-line no-console
      console.log(`  Heap Used:              ${metrics.memoryUsageBytes.heapUsedMB.toFixed(2)} MB`);
      // eslint-disable-next-line no-console
      console.log(`  Heap Total:             ${metrics.memoryUsageBytes.heapTotalMB.toFixed(2)} MB`);
      // eslint-disable-next-line no-console
      console.log(`  RSS:                    ${metrics.memoryUsageBytes.rssMB.toFixed(2)} MB`);
      // eslint-disable-next-line no-console
      console.log(`  External:               ${metrics.memoryUsageBytes.externalMB.toFixed(2)} MB`);
      // eslint-disable-next-line no-console
      console.log('');
    }
  });
}
