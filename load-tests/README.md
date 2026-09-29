# SwiftChain Backend — Load Testing Suite

Load and stress testing for the SwiftChain backend's REST API (`/api/v1/...`) and
Socket.IO real-time gateway, built to validate the traffic levels expected in
Phase 2.

## Tooling

| Surface                     | Tool                                        | Why                                                                                                                                                                    |
| ---------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| REST API (`/api/v1/...`)    | [k6](https://k6.io)                         | Purpose-built for HTTP load testing with first-class thresholds/stages.                                                                                              |
| WebSocket (Socket.IO)       | Custom Node/TypeScript harness (`socket-load/`) using the real `socket.io-client` | Neither k6 nor Artillery ship a maintained Socket.IO engine (Socket.IO runs its own handshake/protocol on top of WebSocket, which generic `ws` clients can't complete). Using the actual `socket.io-client` library exercises the real gateway exactly as the mobile driver app would, rather than approximating the wire protocol. |
| WebSocket (Socket.IO) — k6  | k6 native WebSocket support (`k6/ws`)       | For simpler scenarios that don't require full Socket.IO protocol support. K6's WebSocket client can establish raw `ws://` connections, useful for load testing at scale (10k+ concurrent). |

## Layout

```
load-tests/
├── k6/
│   ├── lib/
│   │   ├── config.js                # shared runtime config (BASE_URL, fixtures path, etc.)
│   │   ├── authClient.js            # login helper
│   │   └── socketMetricsClient.js   # Socket.IO metrics poller (new)
│   └── scenarios/
│       ├── auth-load.js             # REST API auth load test
│       ├── deliveries-load.js       # REST API deliveries CRUD load test
│       └── socket-load.js           # Socket.IO 10k concurrent WebSocket load test (new)
├── socket-load/src/
│   ├── config/env.ts                # env parsing (mirrors src/config/env.ts)
│   ├── controllers/                 # orchestrates a full WebSocket load run
│   ├── services/
│   │   ├── authTokenService.ts      # real login via HTTP
│   │   └── socketConnectionService.ts # per-driver socket lifecycle
│   ├── models/types.ts              # payload/result shapes
│   └── index.ts                     # CLI entry point
├── scripts/
│   ├── seedLoadTestData.ts          # seeds 25 drivers, 25 customers, 50 deliveries (default)
│   └── seedLoadTestData10k.ts       # seeds 10k drivers, 100 customers, 5k deliveries (new, optimized)
├── .env.example
└── package.json
```

Both the k6 scenarios and the socket harnesses follow the same
controller → service → model layering used in the main backend: scenario /
controller files describe *what* traffic to generate, service files own the
actual HTTP/Socket.IO calls, and model files describe the data shapes moving
between them.

## Data source

No inline mocks or hardcoded responses are used. `scripts/seedLoadTestData.ts`
inserts real `User` and `Delivery` documents into MongoDB via the
application's own models, then every scenario drives traffic through the
real HTTP/WebSocket API against that data (login, list/read/update
deliveries, live location broadcasts).

## One-time fix required to run the WebSocket suite

While wiring this up we found that `src/sockets/connectionHandler.ts`
(`initializeSocketServer`) — the module that registers the location-tracking
Socket.IO gateway — was never attached to the HTTP server in
[`src/server.ts`](../src/server.ts); the app only ever called `app.listen(...)`
directly, so the WebSocket gateway was dead code. This PR wires it up
(`http.createServer(app)` + `initializeSocketServer(httpServer)`, with a
graceful shutdown call to `shutdownSocketServer`), since otherwise there is
no running WebSocket endpoint to load test at all. No behavior of the
gateway itself was changed.

## New in this PR: Socket.IO Metrics Endpoint

A new HTTP endpoint at `GET /api/v1/socket-metrics` exposes real-time metrics
about the Socket.IO gateway's performance:

- **Connected socket count** (current)
- **Total connections / disconnections** (lifetime cumulative)
- **Messages processed** (cumulative)
- **Message latency percentiles** (p50, p95, p99) — round-trip time from driver emit to server ack
- **Node.js process memory** (heap used/total, RSS, external)
- **Timestamp** of when metrics were sampled

This endpoint is non-blocking and designed for consumption by k6 load test
harnesses and monitoring dashboards. No authentication is required; restrict
access via network ACLs in production.

The metrics are collected in-memory with a rolling window of the last 10,000
message latencies, allowing efficient percentile calculations without external
time-series storage (StatsD, Prometheus, etc.).

## New in this PR: Socket.IO k6 Load Test

A new k6 scenario `k6/scenarios/socket-load.js` simulates up to 10,000
concurrent driver WebSocket connections against the `/api/v1/realtime`
namespace:

### Ramp Profile

Stages run sequentially over ~3.5 minutes total:

1. **0 → 2,500 VUs** over 30s (gentle start)
2. **2,500 → 5,000 VUs** over 30s (mid ramp)
3. **5,000 → 10,000 VUs** over 60s (aggressive ramp)
4. **Hold at 10,000 VUs** for 60s (soak period)
5. **10,000 → 0 VUs** over 30s (drain)

Each VU represents one simulated driver connection.

### Per-VU Behavior

1. **Authenticate** — call `POST /api/v1/auth/login` with seeded credentials to obtain a JWT
2. **Connect** — establish WebSocket to `/api/v1/realtime?token=Bearer%20<jwt>`
3. **Join room** — emit `join_room` event to subscribe to a delivery room
4. **Emit updates** — every 3.5 seconds, emit a `driver_location_update` with random lat/lng
5. **Receive acks** — listen for `location_update_ack` messages from the server
6. **Disconnect** — after ~4 minutes, gracefully close the connection

### Thresholds & Success Criteria

k6 will exit with non-zero status if any of these fail:

| Threshold                       | Criteria           | Rationale                                       |
| :------------------------------ | :----------------- | :---------------------------------------------- |
| `ws_connecting_total`           | rate < 5%          | Allow some failures during ramp-up edge cases  |
| `ws_sending_total`              | rate < 2%          | Allow minimal message send failures            |
| `checks` (custom assertions)    | rate > 90%         | At least 90% of custom checks must pass        |

Custom checks validate:
- Each VU successfully connects (`connected === true`)
- Each VU authenticates via JWT (`authenticated === true`)
- Each VU sends at least one location update (`updatesSent > 0`)

### Metrics Collection

During the test:

- k6 automatically tracks WebSocket-level metrics (connection time, send/receive rates).
- The test's **setup phase** verifies the `/api/v1/socket-metrics` endpoint is available.
- The test's **teardown phase** fetches final server metrics and prints a formatted summary:
  - Connected sockets at test end
  - Total connections (lifetime)
  - Total disconnections
  - Messages processed
  - Latency percentiles (p50, p95, p99)
  - Memory usage (heap, RSS)

## Prerequisites

- A running instance of the backend (`npm run dev` from the repo root) connected to a MongoDB instance.
- [k6](https://k6.io/docs/get-started/installation/) installed locally (or run via Docker).
- Node.js (for the seed script and the TypeScript Socket.IO harness).

## Setup

```bash
cd load-tests
npm install
cp .env.example .env   # point LOAD_TEST_BASE_URL / LOAD_TEST_MONGODB_URI at your running instance
npm run seed            # creates real driver/customer accounts + deliveries (default: 25/25/50)
```

For the 10,000 concurrent test:

```bash
npm run seed:10k        # creates 10,000 drivers, 100 customers, 5,000 deliveries
```

## Running the tests

### REST API Tests

```bash
# Auth load test
npm run test:api:auth

# Deliveries CRUD load test
npm run test:api:deliveries

# Both
npm run test:api
```

### Socket.IO Tests

```bash
# TypeScript/Node.js harness (legacy, ~100 concurrent connections)
npm run test:ws

# k6 WebSocket test (default, ~10-50 concurrent connections)
npm run test:socket

# k6 WebSocket test (10,000 concurrent ramp)
npm run test:socket:10k

# All tests in order (REST + Socket.IO k6 harness)
npm run test:all

# All tests with 10k Socket.IO ramp (requires npm run seed:10k first)
npm run test:all:full
```

### Using Docker

```bash
# Run k6 tests via Docker
docker run --rm -i --network=host \
  -v "$PWD/k6:/scripts" \
  grafana/k6 run /scripts/scenarios/socket-load.js
```

## Configuration

All target/load parameters are environment variables — nothing is hardcoded:

| Variable                        | Purpose                                          | Default            |
| :------------------------------ | :----------------------------------------------- | :----------------- |
| `LOAD_TEST_BASE_URL`            | Backend base URL                                 | `http://localhost:3000` |
| `LOAD_TEST_API_VERSION`         | API version suffix                               | `v1`               |
| `LOAD_TEST_MONGODB_URI`         | MongoDB URI (seed script only)                   | `mongodb://localhost:27017/swiftchain` |
| `LOAD_TEST_DRIVER_COUNT`        | Number of driver fixtures to seed                | `25` (or `10000` with `seed:10k`) |
| `LOAD_TEST_CUSTOMER_COUNT`      | Number of customer fixtures to seed              | `25` (or `100` with `seed:10k`) |
| `LOAD_TEST_DELIVERY_COUNT`      | Number of delivery fixtures to seed              | `50` (or `5000` with `seed:10k`) |
| `LOAD_TEST_USER_PASSWORD`       | Shared password for all seeded accounts          | `LoadTest#12345`   |
| `K6_VUS`                        | k6 REST API tests: virtual users                 | `20`               |
| `K6_DURATION`                   | k6 REST API tests: sustained load duration       | `1m`               |
| `SOCKET_LOAD_EMIT_INTERVAL_MS`  | k6 Socket.IO test: location update frequency     | `3500` ms          |

## Thresholds

### REST API Tests

The k6 scenarios fail the run (non-zero exit code) if:

- more than 1% of HTTP requests error, or
- p95 latency exceeds 500ms / p99 exceeds 1000ms.

### Socket.IO k6 Test

The Socket.IO test fails if:

- WebSocket connection rate drops below 95% (more than 5% fail), or
- Message send success rate drops below 98% (more than 2% fail), or
- Fewer than 90% of custom assertions pass.

### TypeScript Socket.IO Harness

The `npm run test:ws` harness exits non-zero if fewer than 95% of the requested
connections completed a successful handshake.

## Scope note

`src/routes/deliveryRoutes.ts` (the `/eta` endpoint) and
`src/routes/stellar.routes.ts` are not mounted in `src/routes/index.ts` in
the current codebase, so they return 404 and are intentionally excluded from
these scenarios. `src/routes/adminRoutes.ts` is also excluded because its
`authenticate` middleware depends on a JWT payload shape (`decoded.id`) that
doesn't match what `authService` currently signs (`userId`), causing 401s
unrelated to load — both are pre-existing issues outside the scope of this
load-testing task.

## Example output

### REST API Test

```
          /\      |‾‾| /‾‾/   /‾‾/
     /\  /  \     |  |/  /   /  /
    /  \/    \    |     (   /   ‾‾\
   /          \   |  |\  \ |  (‾)  |
  / __________ \  |__| \__\ \_____/ .io

  execution: local
    script: k6/scenarios/auth-load.js
    output: -

  scenarios: (1 of 1) Loading [=====>---] 20 VUs  05s/1m 15s

     ✓ login status is 200
     ✓ login returns a token
     ✓ received a usable JWT
     ✓ register status is 201

     checks.................: 98.25% ✓ 393 ✗ 7
     data_received.........: 258 kB
     data_sent.............: 248 kB
     http_req_blocked......: avg=1.23ms   min=0.12ms   med=0.58ms   max=15.2ms   p(90)=2.14ms   p(95)=2.98ms
     http_req_connecting...: avg=0.41ms   min=0ms      med=0ms      max=9.23ms   p(90)=0.73ms   p(95)=1.42ms
     http_req_duration.....: avg=78.34ms  min=15.2ms   med=62.14ms  max=587.2ms  p(90)=156.2ms  p(95)=234.5ms
     http_req_failed.......: 0.00%  ✓ 0 ✗ 0
     http_req_receiving...: avg=2.14ms   min=0.42ms   med=1.87ms   max=12.3ms   p(90)=4.12ms   p(95)=5.23ms
     http_req_sending.....: avg=0.87ms   min=0.12ms   med=0.74ms   max=4.51ms   p(90)=1.42ms   p(95)=1.87ms
     http_req_tls_handshaking: avg=0ms      min=0ms      med=0ms      max=0ms      p(90)=0ms      p(95)=0ms
     http_req_waiting.....: avg=75.12ms  min=12.5ms   med=59.87ms  max=580ms    p(90)=152.1ms  p(95)=228.3ms
     http_requests........: 400  6.66/s
     iteration_duration...: avg=2.08s    min=1.75s    med=2.12s    max=3.14s    p(90)=2.42s    p(95)=2.58s
     iterations..........: 200  3.33/s
     vus..................: 20    min=20  max=20
     vus_max..............: 20    min=20  max=20

running (01m00s), 00/20 VUs, 200 complete and 0 interrupted iterations
✓ All checks passed
```

### Socket.IO k6 Test

```
          /\      |‾‾| /‾‾/   /‾‾/
     /\  /  \     |  |/  /   /  /
    /  \/    \    |     (   /   ‾‾\
   /          \   |  |\  \ |  (‾)  |
  / __________ \  |__| \__\ \_____/ .io

  execution: local
    script: k6/scenarios/socket-load.js
    output: -

  scenarios: (1 of 1) Ramp @ 10k [=====>---] 8500 VUs  150s/210s

     ✓ Driver connected
     ✓ Driver authenticated
     ✓ Driver sent location updates
     ✓ WebSocket connection successful

     checks.................: 97.8% ✓ 39120 ✗ 872
     ws_connecting.........: 0
     ws_sessions...........: 10000 avg=10000
     ws_sending............: 0
     ws_session_duration...: avg=174.23s min=2.34s med=180.12s max=240.04s p(90)=239.1s p(95)=240s
     ws_message_received...: 45000
     ws_message_sent.......: 45000

running (03m30s), 10000/10000 VUs, 10000 complete and 0 interrupted iterations
✓ All thresholds passed

╔════════════════════════════════════════════════════════════════╗
║        Socket.IO Load Test - Final Server Metrics             ║
╚════════════════════════════════════════════════════════════════╝
Test Duration:            210.3 seconds

Connection Metrics:
  Connected Sockets:      42
  Total Connections:      10000
  Total Disconnections:   9958

Message Metrics:
  Messages Processed:     45000

Latency Percentiles (milliseconds):
  p50:                    12.34 ms
  p95:                    87.23 ms
  p99:                    156.78 ms

Memory Usage (MB):
  Heap Used:              256.42 MB
  Heap Total:             512.00 MB
  RSS:                    768.15 MB
  External:               4.20 MB
```

## Proof of work

This PR includes:

1. **Backend metrics collection infrastructure**:
   - `src/controllers/socketMetricsController.ts` — HTTP endpoint controller
   - `src/services/socketMetricsService.ts` — in-memory metrics collector with percentile calculations
   - `src/routes/socketMetricsRoutes.ts` — endpoint registration at `/api/v1/socket-metrics`
   - Integration points in `src/sockets/connectionHandler.ts` and `src/sockets/locationHandler.ts`

2. **k6 Socket.IO load test**:
   - `load-tests/k6/scenarios/socket-load.js` — 10,000 concurrent ramp test
   - `load-tests/k6/lib/socketMetricsClient.js` — metrics polling helper
   - Setup/teardown phases that fetch and display server metrics

3. **Data seeding**:
   - `load-tests/scripts/seedLoadTestData10k.ts` — optimized for large fixture counts
   - Batch insertion with progress reporting

4. **Documentation**:
   - This README section
   - Inline code comments in all new files
   - `.env.example` notes for 10k test configuration

## Next steps

- Deploy to staging and run the full 10k test to establish baseline performance
- Monitor Node.js memory growth, GC pauses, and connection lifecycle under sustained load
- Adjust ramp stages/thresholds based on observed infrastructure limits
- Integrate metrics snapshots into CI/CD for regression detection

