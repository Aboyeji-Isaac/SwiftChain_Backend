# SwiftChain_Backend

**SwiftChain_Backend** is the core API service for **SwiftChain**, a Blockchain-Powered Logistics & Escrow Delivery Platform. It connects individuals, businesses, and independent drivers in a decentralized logistics economy, ensuring trust through escrow payments and smart contracts.

---

## 📌 Business Overview

**SwiftChain** revolutionizes logistics by enabling existing transport assets (motorcycles, trucks, independent couriers) to participate in a shared economy. It addresses trust issues in delivery services through blockchain-powered escrow mechanisms.

### Core Problem Solved

Traditional logistics are often centralized, expensive, and lack trust between unknown parties. SwiftChain bridges this gap by locking payments in escrow until delivery is confirmed.

### Financial Inclusion Benefits

The platform empowers:

- **Small Logistics Operators & Drivers**: Access to a steady stream of delivery requests.
- **Underserved Communities**: Access to global payments via Stellar's borderless network.
- **Cross-Border Merchants**: Seamless settlement for international goods movement.

### Target Market

- 🌍 **African Logistics Markets**
- 🏢 **SMEs & E-commerce Merchants**
- 🛵 **Courier Startups & Independent Drivers**
- 🚢 **Cross-Border Trade Facilitators**

### Revenue Model

1. **Delivery Commission Fees**: Percentage of each successful delivery.
2. **Escrow Service Charges**: Small fee for securing the transaction.
3. **Enterprise Logistics APIs**: Subscription for high-volume business integration.
4. **Cross-Border Settlement Fees**: Currency conversion and transfer fees.
5. **Premium Analytics**: Insights for fleet owners and businesses.

---

## 🏗 System Architecture

SwiftChain operates as a distributed system across three repositories:

1.  **SwiftChain_Frontend**: Next.js + TypeScript + TailwindCSS (User Interface)
2.  **SwiftChain_Backend**: Node.js + Express.js + TypeScript + MongoDB (Core Logic)
3.  **SwiftChain_SmartContract**: Stellar Soroban + Rust (Escrow & Trust)

### Backend Responsibilities

The backend serves as the central hub connecting the frontend, database, and blockchain layers. Key responsibilities include:

- **REST API** for platform operations.
- **Authentication & Authorization** (JWT, RBAC).
- **Delivery & Shipment Management** (CRUD, Tracking).
- **Driver Assignment Algorithms**.
- **File Upload Services** (Receipts, Proof of Delivery).
- **Real-Time Updates** (WebSockets/Polling).
- **Blockchain Integration Layer** (Stellar/Soroban events).

---

## 🛠 Technology Stack

- **Runtime**: Node.js
- **Framework**: Express.js
- **Language**: TypeScript
- **Database**: MongoDB (with Mongoose ODM)
- **Authentication**: JWT (JSON Web Tokens)
- **Validation**: Zod
- **File Storage**: Cloudinary / AWS S3
- **Real-Time**: Socket.io / Polling
- **Documentation**: Swagger / OpenAPI
- **Logging**: Winston
- **Containerization**: Docker & Docker Compose
- **CI/CD**: GitHub Actions

---

## 🚀 Functional Requirements

### 1. Authentication & Roles

- **Users**: Register, Login, Create Requests.
- **Drivers**: Register, Verify, Accept Jobs.
- **Admins**: Platform Management.
- **Security**: JWT-based stateless auth with Role-Based Access Control (RBAC).

### 2. Delivery Operations

- **Create Delivery**: Customer details, pickup/drop-off locations, package info.
- **Delivery List**: Filtering, pagination, and status tracking.
- **Status Workflow**: Pending -> Assigned -> Picked Up -> In Transit -> Delivered.

### 3. Driver Assignment

- Mechanism to assign available drivers to pending delivery requests.

### 4. Shipments & Escrow

- **Shipment Tracking**: Detailed tracking of goods.
- **Escrow Logic**: Integration with Stellar Smart Contracts to lock/release funds based on delivery status.

### 5. File Uploads

- Secure upload of delivery receipts, images, and documents (PDF/JPG).

---

## 📡 API Endpoints

All endpoints are versioned under the `/api` prefix (e.g. `/api/v1/...`). The list below
mirrors what is mounted in `src/routes/index.ts`.

### Authentication

- `POST /api/v1/auth/register` - Register a new user/driver.
- `POST /api/v1/auth/login` - Authenticate and retrieve token.

### Deliveries

- `POST /api/v1/deliveries` - Create a new delivery request.
- `GET /api/v1/deliveries` - Retrieve a list of deliveries (with filters).
- `GET|PATCH /api/v1/deliveries/:id` - Retrieve or update a delivery.
- `PATCH /api/v1/deliveries/:id/assign-driver` - Assign a driver (admin only; requires a
  fully initialised escrow).
- `PATCH /api/v1/deliveries/:id/archive` / `.../restore` - Soft-delete / restore.
- `GET /api/v1/deliveries/:id/qrcode` - Handoff verification QR code.
- `GET /api/v1/deliveries/:id/eta` - Estimated arrival time.
- `PUT /api/v1/deliveries/:id/status` - Advance the delivery status (driver/admin).

### Escrow

- `GET /api/v1/escrow/delivery/:id` - Fetch the escrow record (locking state, amount, asset,
  contract id, on-chain transaction hashes) associated with a delivery. `:id` accepts either the
  delivery `_id` or its business `deliveryId`.
- `GET /api/v1/escrow/contract/:contractId` - Fetch the escrow record by Soroban contract id.
- `POST /api/v1/escrow/fund` - Record an on-chain `escrow_funded` event (idempotent).
- `POST /api/v1/escrow/sync` - Manually trigger an `escrow_funded` indexer poll.
- `POST /api/v1/escrow/release` - Release an escrow (Redlock-protected).
- `GET /api/v1/admin/escrows/flagged` - List escrows flagged as expired (admin only).
- `PATCH /api/v1/admin/escrows/:id/resolve` - Resolve a flagged escrow (admin only).

### Transactions

- `POST /api/v1/transactions/escrow-lock` - Build the unsigned, simulation-prepared Soroban XDR
  that locks a delivery's escrow amount. Accepts `{ deliveryId, payerAddress }`; the amount and
  contract target are resolved server-side from MongoDB and the deployment configuration. The
  returned base64 envelope is signed and submitted by the client wallet — the backend never holds
  secret keys.
- `POST /api/v1/transactions/submit` - Submit a signed escrow-lock XDR with automatic
  `tx_bad_seq` retry.

### Monitoring

- `GET /api/v1/monitor/indexer-lag` - On-demand indexer-lag check against the live ledger
  (admin only).
- `GET /api/v1/monitor/indexer-lag/alerts` - Recent persisted indexer-lag alerts (admin only).
- `GET /api/v1/health` - Liveness/readiness probe with Soroban RPC health check.

### Indexer

- `GET /api/v1/indexer/escrows/:escrowId` - Escrow status from the database.
- `POST /api/v1/indexer/escrows/sync/released` - Manually sync `escrow_released` events.
- `POST /api/v1/indexer/escrows/sync/refunded` - Manually sync `escrow_refunded` events.
- `POST /api/v1/indexer/delivery-created` - Process a `delivery_created` event (indexer worker).

### Uploads

- `POST /api/v1/uploads/evidence` - Upload dispute evidence media (authenticated).
- `GET /api/v1/uploads/evidence/:disputeId` - List evidence for a dispute (authenticated).

---

## 📄 Pagination, Sorting & Filtering

Collection endpoints can share a standardized query interface via the
`buildQueryOptions` middleware in `src/middlewares/queryMiddleware.ts`, which
parses and validates the query string once and hands the service layer a
ready-to-use Mongoose filter, sort and page window.

| Parameter | Description | Example |
| --------- | ----------- | ------- |
| `page` | 1-based page number | `?page=2` |
| `limit` | Items per page, clamped to the route maximum | `?limit=50` |
| `sort` | Comma-separated fields, `-` prefix for descending | `?sort=-createdAt,name` |
| `search` | Case-insensitive search across searchable fields | `?search=lagos` |

Filters accept direct equality or the comparison operators `eq`, `ne`, `gt`,
`gte`, `lt`, `lte`, `in` and `nin` in bracket notation:

```bash
GET /api/v1/deliveries?status=pending&amount[gte]=100&sort=-amount&page=1&limit=20
```

Each route declares the fields it exposes, so only whitelisted fields can be
filtered or sorted on. `buildPaginationMeta` produces the accompanying
metadata:

```json
{
  "totalItems": 137,
  "totalPages": 7,
  "currentPage": 1,
  "limit": 20,
  "hasNextPage": true,
  "hasPreviousPage": false,
  "nextPage": 2,
  "previousPage": null
}
```

---

## 🗺 Development Roadmap

### Phase 1 — MVP (Minimal Logistics Backend)

- [ ] Authentication System (Register/Login/JWT).
- [ ] Core Delivery CRUD Endpoints.
- [ ] Driver Assignment Logic.
- [ ] MongoDB Schema Design.
- [ ] Basic Validation & Error Handling.

### Phase 2 — Escrow Payment Integration

- [ ] Stellar Payment Service Integration.
- [ ] Escrow Payment Initiation Endpoints.
- [ ] Transaction Tracking.
- [ ] Payment Verification Webhooks.

### Phase 3 — Smart Contract Integration

- [ ] Soroban Smart Contract Interaction Layer.
- [ ] Blockchain Event Listeners.
- [ ] Escrow Release Verification Logic.
- [ ] Delivery Proof Validation on Chain.

### Phase 4 — Platform Scaling

- [ ] Logistics Analytics & Reporting APIs.
- [ ] Fleet Management Features.
- [ ] Reputation & Scoring System for Drivers.
- [ ] Cross-Border Payment Logic.
- [ ] Advanced Monitoring (Prometheus/Grafana).

---

## 📂 Project Structure

```bash
SwiftChain_Backend/
├── .github/
│   └── workflows/
│       └── ci.yml          # GitHub Actions CI pipeline
├── docs/                   # Documentation files
├── postman/                # Postman collections
├── scripts/                # Utility scripts (seed, migration)
├── src/
│   ├── config/             # Environment & App Config
│   ├── controllers/        # Request Handlers
│   ├── services/           # Business Logic
│   ├── routes/             # API Route Definitions
│   ├── middlewares/        # Express Middlewares (Auth, Error, Validation)
│   ├── models/             # Mongoose Models
│   ├── repositories/       # Data Access Layer
│   ├── validators/         # Zod/Joi Schemas
│   ├── utils/              # Helper Functions
│   ├── types/              # TypeScript Type Definitions
│   ├── interfaces/         # TypeScript Interfaces
│   ├── events/             # Event Emitters/Handlers
│   ├── sockets/            # WebSocket Handlers
│   ├── uploads/            # File Upload Logic
│   ├── blockchain/         # Stellar/Soroban Integration
│   ├── database/           # DB Connection Logic
│   ├── app.ts              # Express App Setup
│   └── server.ts           # Entry Point
├── tests/                  # Unit & Integration Tests
├── .env.example            # Environment Variables Example
├── .eslintrc               # Linter Config
├── .prettierrc             # Formatter Config
├── docker-compose.yml      # Docker Services
├── Dockerfile              # Docker Build Instructions
├── package.json            # Dependencies & Scripts
├── tsconfig.json           # TypeScript Config
└── README.md               # Project Documentation
```

---

## ⚙️ Installation & Setup

### Prerequisites

- Node.js v18+
- MongoDB v6.0+
- Docker (Optional)

### 1. Clone the Repository

```bash
git clone https://github.com/your-org/SwiftChain_Backend.git
cd SwiftChain_Backend
```

### 2. Environment Configuration

Copy the example environment file and update the values.

```bash
cp .env.example .env
```

### 3. Install Dependencies

```bash
pnpm install
```

### 4. Run Development Server

```bash
pnpm run dev
```

### 5. Run with Docker

```bash
docker-compose up --build
```

---

## 🧪 Testing

Run the test suite using Jest:

```bash
pnpm test
```

---

## 🤝 Contribution

1. Fork the repository.
2. Create a feature branch (`git checkout -b feature/amazing-feature`).
3. Commit your changes (`git commit -m 'Add some amazing feature'`).
4. Push to the branch (`git push origin feature/amazing-feature`).
5. Open a Pull Request.

---

linked PR 5,4,6

## 📄 License

This project is licensed under the ISC License.
