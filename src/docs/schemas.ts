/**
 * Reusable OpenAPI 3.0 component schemas for the SwiftChain Backend API.
 *
 * Route-level operations `$ref` these instead of restating shapes, so the
 * schema for a `Delivery`, a `Fleet` or an `ApiError` is defined exactly once
 * and stays consistent across every endpoint that returns it.
 *
 * Kept separate from `swagger.ts` purely for readability: it is imported into
 * the single OpenAPI document assembled there.
 */

import swaggerJSDoc from 'swagger-jsdoc';

type SchemaMap = NonNullable<swaggerJSDoc.Components['schemas']>;

export const schemas: SchemaMap = {
  // ─── Errors & envelopes ─────────────────────────────────────────────────────
  ErrorResponse: {
    type: 'object',
    properties: {
      status: { type: 'string', example: 'error' },
      message: { type: 'string', example: 'Something went wrong' },
    },
    required: ['status', 'message'],
  },
  ApiError: {
    type: 'object',
    description: 'Canonical error envelope returned by the API.',
    properties: {
      success: { type: 'boolean', example: false },
      data: { type: 'object', nullable: true, example: null },
      error: { type: 'string', example: 'Delivery not found' },
      message: { type: 'string', example: 'Delivery not found' },
    },
    required: ['success', 'error', 'message'],
  },
  ValidationErrorResponse: {
    type: 'object',
    properties: {
      status: { type: 'string', example: 'error' },
      statusCode: { type: 'integer', example: 400 },
      message: { type: 'string', example: 'Validation failed' },
      errors: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            field: { type: 'string', example: 'email' },
            message: { type: 'string', example: 'Please provide a valid email address' },
          },
        },
      },
    },
  },
  PaginationMeta: {
    type: 'object',
    properties: {
      total: { type: 'integer', example: 42 },
      page: { type: 'integer', example: 1 },
      limit: { type: 'integer', example: 10 },
      totalPages: { type: 'integer', example: 5 },
    },
  },

  // ─── Auth & users ───────────────────────────────────────────────────────────
  User: {
    type: 'object',
    properties: {
      id: { type: 'string', example: '6512f1a2b3c4d5e6f7890abc' },
      email: { type: 'string', format: 'email', example: 'user@swiftchain.com' },
      firstName: { type: 'string', example: 'Grace' },
      lastName: { type: 'string', example: 'Hopper' },
      role: { type: 'string', enum: ['user', 'driver', 'admin', 'enterprise'], example: 'user' },
      status: { type: 'string', enum: ['active', 'suspended', 'banned'], example: 'active' },
      walletAddress: { type: 'string', nullable: true, example: null },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  RegisterRequest: {
    type: 'object',
    required: ['firstName', 'lastName', 'email', 'password'],
    properties: {
      firstName: { type: 'string', minLength: 2, example: 'Grace' },
      lastName: { type: 'string', minLength: 2, example: 'Hopper' },
      email: { type: 'string', format: 'email', example: 'grace.hopper@swiftchain.com' },
      password: { type: 'string', format: 'password', minLength: 8, example: 'CompileThis123!' },
    },
  },
  LoginRequest: {
    type: 'object',
    required: ['email', 'password'],
    properties: {
      email: { type: 'string', format: 'email', example: 'grace.hopper@swiftchain.com' },
      password: { type: 'string', format: 'password', example: 'CompileThis123!' },
    },
  },
  AuthSuccessResponse: {
    type: 'object',
    properties: {
      status: { type: 'string', example: 'success' },
      message: { type: 'string', example: 'Login successful' },
      data: {
        type: 'object',
        properties: {
          user: { $ref: '#/components/schemas/User' },
          token: { type: 'string', example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' },
        },
      },
    },
  },
  RegisterSuccessResponse: {
    type: 'object',
    properties: {
      status: { type: 'string', example: 'success' },
      message: { type: 'string', example: 'User registered successfully' },
      data: {
        type: 'object',
        properties: {
          user: { $ref: '#/components/schemas/User' },
        },
      },
    },
  },
  UpdateWalletRequest: {
    type: 'object',
    required: ['walletAddress'],
    properties: {
      walletAddress: {
        type: 'string',
        example: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
      },
    },
  },
  UpdatePasswordRequest: {
    type: 'object',
    required: ['currentPassword', 'newPassword'],
    properties: {
      currentPassword: { type: 'string', format: 'password', example: 'OldPassword123!' },
      newPassword: { type: 'string', format: 'password', minLength: 8, example: 'NewPassword123!' },
    },
  },
  UpdateUserRequest: {
    type: 'object',
    properties: {
      firstName: { type: 'string', example: 'Grace' },
      lastName: { type: 'string', example: 'Hopper' },
      role: { type: 'string', enum: ['user', 'driver', 'admin', 'enterprise'] },
      status: { type: 'string', enum: ['active', 'suspended', 'banned'] },
    },
  },

  // ─── Deliveries ─────────────────────────────────────────────────────────────
  DeliveryLocation: {
    type: 'object',
    required: ['address'],
    properties: {
      address: { type: 'string', example: '123 Pickup St' },
      city: { type: 'string', example: 'New York' },
      state: { type: 'string', example: 'NY' },
      zipCode: { type: 'string', example: '10001' },
      instructions: { type: 'string', example: 'Ring bell' },
    },
  },
  DeliveryPackage: {
    type: 'object',
    required: ['description', 'weight'],
    properties: {
      description: { type: 'string', example: 'Electronics' },
      weight: { type: 'number', example: 2.5 },
      size: { type: 'string', example: 'Medium' },
      isFragile: { type: 'boolean', example: true },
      requiresSignature: { type: 'boolean', example: true },
    },
  },
  CreateDeliveryRequest: {
    type: 'object',
    required: ['trackingNumber', 'customer', 'pickup', 'dropoff', 'package'],
    properties: {
      trackingNumber: { type: 'string', example: 'SWIFT-001' },
      customer: {
        type: 'object',
        required: ['name', 'phone'],
        properties: {
          name: { type: 'string', example: 'John Doe' },
          phone: { type: 'string', example: '+1234567890' },
          email: { type: 'string', format: 'email', example: 'john@example.com' },
        },
      },
      pickup: { $ref: '#/components/schemas/DeliveryLocation' },
      dropoff: { $ref: '#/components/schemas/DeliveryLocation' },
      package: { $ref: '#/components/schemas/DeliveryPackage' },
      deliveryFee: { type: 'number', example: 15.99 },
      escrowAmount: { type: 'number', example: 150.0 },
      notes: { type: 'string', example: 'Leave at front desk' },
    },
  },
  UpdateDeliveryRequest: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['pending', 'funded', 'assigned', 'in_progress', 'completed', 'cancelled'],
      },
      driver: { type: 'string', example: '6512f1a2b3c4d5e6f7890abc' },
      estimatedDistance: { type: 'number', example: 12.4 },
      estimatedDuration: { type: 'number', example: 35 },
      stellarTransactionId: { type: 'string', example: 'a1b2c3d4e5f6...' },
      notes: { type: 'string', example: 'Driver en route' },
    },
  },
  Delivery: {
    type: 'object',
    properties: {
      id: { type: 'string', example: '6512f1a2b3c4d5e6f7890abc' },
      trackingNumber: { type: 'string', example: 'SWIFT-001' },
      driverId: { type: 'string', nullable: true, example: null },
      status: {
        type: 'string',
        enum: ['pending', 'funded', 'assigned', 'in_progress', 'completed', 'cancelled'],
      },
      customer: { type: 'object' },
      pickup: { $ref: '#/components/schemas/DeliveryLocation' },
      dropoff: { $ref: '#/components/schemas/DeliveryLocation' },
      package: { $ref: '#/components/schemas/DeliveryPackage' },
      deliveryFee: { type: 'number', example: 15.99 },
      escrowAmount: { type: 'number', example: 150.0 },
      estimatedDuration: { type: 'number', example: 35 },
      actualDuration: { type: 'number', nullable: true, example: 41 },
      isDeleted: { type: 'boolean', example: false },
      deletedAt: { type: 'string', format: 'date-time', nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  DeliveryListResponse: {
    type: 'object',
    properties: {
      status: { type: 'string', example: 'success' },
      data: { type: 'array', items: { $ref: '#/components/schemas/Delivery' } },
      meta: { $ref: '#/components/schemas/PaginationMeta' },
    },
  },
  DeliveryResponse: {
    type: 'object',
    properties: {
      status: { type: 'string', example: 'success' },
      data: { $ref: '#/components/schemas/Delivery' },
      message: { type: 'string', example: 'Delivery archived successfully' },
    },
  },
  UpdateDeliveryStatusRequest: {
    type: 'object',
    required: ['status'],
    properties: {
      status: {
        type: 'string',
        enum: ['pending', 'assigned', 'picked_up', 'in_transit', 'delivered'],
        example: 'assigned',
      },
    },
  },
  ProofOfDelivery: {
    type: 'object',
    properties: {
      storageKey: { type: 'string', example: 'proof/delivery-1.jpg' },
      imageUrl: {
        type: 'string',
        format: 'uri',
        example: 'https://cdn.swiftchain.com/proof/1.jpg',
      },
      storageDriver: { type: 'string', example: 'local' },
      mimeType: { type: 'string', example: 'image/jpeg' },
      sizeBytes: { type: 'integer', example: 204800 },
      uploadedBy: { type: 'string', example: '6512f1a2b3c4d5e6f7890abc' },
      uploadedAt: { type: 'string', format: 'date-time' },
    },
  },
  BulkDeliveryRowError: {
    type: 'object',
    properties: {
      row: { type: 'integer', example: 3 },
      field: { type: 'string', example: 'trackingNumber' },
      message: { type: 'string', example: 'trackingNumber is required' },
    },
  },

  // ─── Escrow ─────────────────────────────────────────────────────────────────
  FundEscrowRequest: {
    type: 'object',
    required: ['deliveryId', 'contractId', 'transactionHash', 'amount', 'asset'],
    properties: {
      deliveryId: { type: 'string', example: '6512f1a2b3c4d5e6f7890abc' },
      contractId: {
        type: 'string',
        example: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
      },
      transactionHash: { type: 'string', example: 'a1b2c3d4e5f6...' },
      amount: { type: 'number', example: 150.0 },
      asset: { type: 'string', example: 'XLM' },
      fundedBy: {
        type: 'string',
        example: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
      },
      ledger: { type: 'integer', example: 123456 },
    },
  },
  ReleaseEscrowRequest: {
    type: 'object',
    required: ['escrowId', 'transactionHash'],
    properties: {
      escrowId: { type: 'string', example: '6512f1a2b3c4d5e6f7890abc' },
      transactionHash: { type: 'string', example: 'a1b2c3d4e5f6...' },
      ledger: { type: 'integer', example: 123456 },
    },
  },
  SyncEscrowRequest: {
    type: 'object',
    required: ['startLedger'],
    properties: {
      startLedger: {
        type: 'integer',
        description: 'Ledger sequence to start from (inclusive)',
        example: 1000000,
      },
      contractId: { type: 'string', description: 'Escrow contract id (defaults to env var)' },
    },
  },
  Escrow: {
    type: 'object',
    properties: {
      id: { type: 'string', example: '6512f1a2b3c4d5e6f7890abc' },
      delivery: { type: 'string', example: '6512f1a2b3c4d5e6f7890abc' },
      status: {
        type: 'string',
        enum: ['pending', 'locked', 'released', 'refunded', 'disputed', 'expired', 'resolved'],
        example: 'locked',
      },
      amount: { type: 'number', example: 150.0 },
      assetCode: { type: 'string', example: 'XLM' },
      assetIssuer: { type: 'string', nullable: true },
      contractId: { type: 'string', example: 'CAAAA...' },
      payerAddress: { type: 'string', nullable: true },
      payeeAddress: { type: 'string', nullable: true },
      lockedAt: { type: 'string', format: 'date-time', nullable: true },
      releasedAt: { type: 'string', format: 'date-time', nullable: true },
      expiresAt: { type: 'string', format: 'date-time', nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  EscrowResponse: {
    type: 'object',
    properties: {
      status: { type: 'string', example: 'success' },
      message: { type: 'string', example: 'Escrow funded successfully' },
      data: {
        type: 'object',
        properties: { escrow: { $ref: '#/components/schemas/Escrow' } },
      },
    },
  },

  // ─── Webhooks ───────────────────────────────────────────────────────────────
  WebhookSubscription: {
    type: 'object',
    properties: {
      id: { type: 'string', example: '6512f1a2b3c4d5e6f7890abc' },
      merchantId: { type: 'string', example: '6512f1a2b3c4d5e6f7890abc' },
      url: {
        type: 'string',
        format: 'uri',
        example: 'https://merchant.example.com/hooks/swiftchain',
      },
      events: {
        type: 'array',
        items: {
          type: 'string',
          enum: [
            'delivery.pending',
            'delivery.funded',
            'delivery.assigned',
            'delivery.in_progress',
            'delivery.completed',
            'delivery.cancelled',
          ],
        },
      },
      isActive: { type: 'boolean', example: true },
      description: { type: 'string', nullable: true, example: 'Production endpoint' },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  RegisterWebhookRequest: {
    type: 'object',
    required: ['url', 'events'],
    properties: {
      url: {
        type: 'string',
        format: 'uri',
        example: 'https://merchant.example.com/hooks/swiftchain',
      },
      events: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'string',
          enum: [
            'delivery.pending',
            'delivery.funded',
            'delivery.assigned',
            'delivery.in_progress',
            'delivery.completed',
            'delivery.cancelled',
          ],
        },
      },
      description: { type: 'string', maxLength: 500, example: 'Production endpoint' },
    },
  },
  UpdateWebhookRequest: {
    type: 'object',
    properties: {
      url: { type: 'string', format: 'uri' },
      events: { type: 'array', items: { type: 'string' } },
      isActive: { type: 'boolean', example: true },
      description: { type: 'string', maxLength: 500 },
    },
  },

  // ─── Fleets ─────────────────────────────────────────────────────────────────
  FleetMember: {
    type: 'object',
    properties: {
      userId: { type: 'string', example: '6512f1a2b3c4d5e6f7890abc' },
      role: { type: 'string', enum: ['admin', 'driver', 'viewer'], example: 'driver' },
      joinedAt: { type: 'string', format: 'date-time' },
    },
  },
  Fleet: {
    type: 'object',
    properties: {
      id: { type: 'string', example: '6512f1a2b3c4d5e6f7890abc' },
      name: { type: 'string', example: 'Swift Logistics' },
      treasuryAddress: {
        type: 'string',
        example: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
      },
      ownerId: { type: 'string', example: '6512f1a2b3c4d5e6f7890abc' },
      members: { type: 'array', items: { $ref: '#/components/schemas/FleetMember' } },
      isActive: { type: 'boolean', example: true },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  CreateFleetRequest: {
    type: 'object',
    required: ['name', 'treasuryAddress', 'businessMetadata'],
    properties: {
      name: { type: 'string', minLength: 2, example: 'Swift Logistics' },
      treasuryAddress: {
        type: 'string',
        example: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
      },
      businessMetadata: {
        type: 'object',
        required: ['companyName', 'contactEmail'],
        properties: {
          companyName: { type: 'string', example: 'Swift Logistics Ltd' },
          industry: { type: 'string', example: 'Logistics' },
          registrationNumber: { type: 'string', example: 'RC-1234567' },
          vatNumber: { type: 'string', example: 'VAT-9876543' },
          address: {
            type: 'object',
            properties: {
              street: { type: 'string', example: '12 Marina Rd' },
              city: { type: 'string', example: 'Lagos' },
              country: { type: 'string', example: 'NG' },
              postalCode: { type: 'string', example: '100001' },
            },
          },
          contactEmail: { type: 'string', format: 'email', example: 'ops@swiftlogistics.example' },
          contactPhone: { type: 'string', example: '+2348000000000' },
          website: { type: 'string', format: 'uri', example: 'https://swiftlogistics.example' },
        },
      },
    },
  },
  FleetInvitation: {
    type: 'object',
    properties: {
      id: { type: 'string', example: '6512f1a2b3c4d5e6f7890abc' },
      fleetId: { type: 'string', example: '6512f1a2b3c4d5e6f7890abc' },
      driverId: { type: 'string', example: '6512f1a2b3c4d5e6f7890abc' },
      status: { type: 'string', enum: ['pending', 'accepted', 'declined'], example: 'pending' },
      invitedBy: { type: 'string', example: '6512f1a2b3c4d5e6f7890abc' },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  FleetMetrics: {
    type: 'object',
    properties: {
      fleetId: { type: 'string', example: '6512f1a2b3c4d5e6f7890abc' },
      totalDeliveries: { type: 'integer', example: 320 },
      completedDeliveries: { type: 'integer', example: 300 },
      activeDrivers: { type: 'integer', example: 12 },
      totalRevenue: { type: 'number', example: 48250.75 },
    },
  },

  // ─── Disputes ───────────────────────────────────────────────────────────────
  Dispute: {
    type: 'object',
    properties: {
      id: { type: 'string', example: '6512f1a2b3c4d5e6f7890abc' },
      disputeId: { type: 'string', nullable: true },
      deliveryId: { type: 'string', example: '6512f1a2b3c4d5e6f7890abc' },
      raisedBy: { type: 'string', example: '6512f1a2b3c4d5e6f7890abc' },
      reason: {
        type: 'string',
        enum: ['damaged_package', 'late_delivery', 'wrong_item', 'non_delivery', 'other'],
        example: 'late_delivery',
      },
      description: { type: 'string', example: 'The parcel arrived two days late.' },
      evidenceUrls: { type: 'array', items: { type: 'string', format: 'uri' } },
      status: {
        type: 'string',
        enum: ['open', 'under_review', 'resolved', 'rejected'],
        example: 'open',
      },
      resolutionNotes: { type: 'string', nullable: true },
      resolvedAt: { type: 'string', format: 'date-time', nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  CreateDisputeRequest: {
    type: 'object',
    required: ['deliveryId', 'reason', 'description'],
    properties: {
      deliveryId: { type: 'string', example: '6512f1a2b3c4d5e6f7890abc' },
      reason: {
        type: 'string',
        enum: ['damaged_package', 'late_delivery', 'wrong_item', 'non_delivery', 'other'],
      },
      description: { type: 'string', minLength: 10, maxLength: 2000 },
      evidenceUrls: { type: 'array', maxItems: 10, items: { type: 'string', format: 'uri' } },
    },
  },
  ResolveDisputeRequest: {
    type: 'object',
    required: ['status', 'resolutionNotes'],
    properties: {
      status: { type: 'string', enum: ['open', 'under_review', 'resolved', 'rejected'] },
      resolutionNotes: { type: 'string', minLength: 10, maxLength: 2000 },
    },
  },
  AddEvidenceRequest: {
    type: 'object',
    required: ['evidenceUrls'],
    properties: {
      evidenceUrls: {
        type: 'array',
        minItems: 1,
        maxItems: 10,
        items: { type: 'string', format: 'uri' },
      },
    },
  },
  UpdateDisputeRequest: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        enum: ['damaged_package', 'late_delivery', 'wrong_item', 'non_delivery', 'other'],
      },
      description: { type: 'string', minLength: 10, maxLength: 2000 },
      evidenceUrls: { type: 'array', maxItems: 10, items: { type: 'string', format: 'uri' } },
    },
  },

  // ─── Notifications ──────────────────────────────────────────────────────────
  NotificationPreference: {
    type: 'object',
    properties: {
      pushEnabled: { type: 'boolean', example: true },
      enabledEvents: {
        type: 'array',
        items: {
          type: 'string',
          enum: [
            'delivery.pending',
            'delivery.assigned',
            'delivery.in_progress',
            'delivery.completed',
            'delivery.cancelled',
          ],
        },
      },
      deviceCount: { type: 'integer', example: 2 },
    },
  },
  UpdateNotificationPreferencesRequest: {
    type: 'object',
    properties: {
      pushEnabled: { type: 'boolean', example: true },
      enabledEvents: { type: 'array', items: { type: 'string' } },
    },
  },
  Notification: {
    type: 'object',
    properties: {
      id: { type: 'string', example: '6512f1a2b3c4d5e6f7890abc' },
      event: { type: 'string', example: 'delivery.completed' },
      title: { type: 'string', example: 'Delivery completed' },
      body: { type: 'string', example: 'Your delivery SWIFT-001 was completed.' },
      read: { type: 'boolean', example: false },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  RegisterDeviceRequest: {
    type: 'object',
    required: ['token', 'platform'],
    properties: {
      token: { type: 'string', example: 'fcm-device-token' },
      platform: { type: 'string', enum: ['ios', 'android', 'web'] },
    },
  },
  UnregisterDeviceRequest: {
    type: 'object',
    required: ['token'],
    properties: { token: { type: 'string', example: 'fcm-device-token' } },
  },

  // ─── Drivers ────────────────────────────────────────────────────────────────
  VehicleDetails: {
    type: 'object',
    properties: {
      make: { type: 'string', example: 'Toyota' },
      model: { type: 'string', example: 'Hiace' },
      year: { type: 'integer', example: 2020 },
      plateNumber: { type: 'string', example: 'ABC-123' },
      capacityKg: { type: 'number', example: 800 },
    },
  },
  SetVehicleDetailsRequest: {
    type: 'object',
    required: ['make', 'model', 'plateNumber'],
    properties: {
      make: { type: 'string', example: 'Toyota' },
      model: { type: 'string', example: 'Hiace' },
      year: { type: 'integer', example: 2020 },
      plateNumber: { type: 'string', example: 'ABC-123' },
      capacityKg: { type: 'number', example: 800 },
    },
  },
  UpdateDriverLocationRequest: {
    type: 'object',
    required: ['lat', 'lng'],
    properties: {
      lat: { type: 'number', example: 6.5244 },
      lng: { type: 'number', example: 3.3792 },
      heading: { type: 'number', example: 135 },
      speed: { type: 'number', example: 42.5 },
      accuracy: { type: 'number', example: 8 },
      isAvailable: { type: 'boolean', example: true },
      currentDeliveryId: { type: 'string', nullable: true },
    },
  },
  LeaderboardEntry: {
    type: 'object',
    properties: {
      rank: { type: 'integer', example: 1 },
      userId: { type: 'string', example: '6512f1a2b3c4d5e6f7890abc' },
      reputationPoints: { type: 'integer', example: 1250 },
      tier: { type: 'string', enum: ['bronze', 'silver', 'gold', 'platinum'] },
      totalDeliveries: { type: 'integer', example: 120 },
      completedDeliveries: { type: 'integer', example: 118 },
    },
  },
  DriverRating: {
    type: 'object',
    description: 'A driver’s performance rating and penalty state, derived from delivery history.',
    properties: {
      driverId: { type: 'string', example: '6512f1a2b3c4d5e6f7890abc' },
      rating: { type: 'number', minimum: 0, maximum: 5, example: 4.6 },
      reputationPoints: { type: 'integer', example: 250 },
      tier: { type: 'string', enum: ['bronze', 'silver', 'gold', 'platinum'] },
      totalDeliveries: { type: 'integer', example: 40 },
      completedDeliveries: { type: 'integer', example: 36 },
      delayedDeliveries: { type: 'integer', example: 4 },
      cancelledDeliveries: { type: 'integer', example: 2 },
      lateDeliveryRate: { type: 'number', example: 0.11 },
      cancellationRate: { type: 'number', example: 0.05 },
      isSuspended: { type: 'boolean', example: false },
      suspendedUntil: { type: 'string', format: 'date-time', nullable: true },
      suspensionReason: { type: 'string', nullable: true },
      penaltyApplied: { type: 'boolean', example: false },
      lastRatingUpdate: { type: 'string', format: 'date-time', nullable: true },
    },
  },
  DriverRatingResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      data: {
        type: 'object',
        properties: { rating: { $ref: '#/components/schemas/DriverRating' } },
      },
      error: { type: 'object', nullable: true, example: null },
      message: { type: 'string', example: 'Driver rating retrieved successfully' },
    },
  },
  RecalculateRatingsResult: {
    type: 'object',
    properties: {
      processed: { type: 'integer', example: 42 },
      updated: { type: 'integer', example: 42 },
      suspended: { type: 'integer', example: 1 },
      lifted: { type: 'integer', example: 2 },
      failed: { type: 'integer', example: 0 },
    },
  },

  // ─── Profile ────────────────────────────────────────────────────────────────
  ProfileResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      data: {
        type: 'object',
        properties: { user: { $ref: '#/components/schemas/User' } },
      },
      message: { type: 'string', example: 'Profile retrieved successfully' },
    },
  },
  ProfilePictureResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      data: {
        type: 'object',
        properties: {
          profilePicture: { type: 'string', format: 'uri' },
          profilePictureKey: { type: 'string' },
        },
      },
      message: { type: 'string', example: 'Profile picture uploaded successfully' },
    },
  },

  // ─── Health & monitoring ────────────────────────────────────────────────────
  HealthResponse: {
    type: 'object',
    properties: {
      status: { type: 'string', example: 'success' },
      message: { type: 'string', example: 'Service healthy' },
      data: {
        type: 'object',
        properties: {
          uptime: { type: 'number', example: 12345.67 },
          database: { type: 'string', enum: ['connected', 'disconnected'], example: 'connected' },
          stellarRpc: { type: 'string', enum: ['reachable', 'unreachable'], example: 'reachable' },
        },
      },
    },
  },
  CircuitBreakerStatusResponse: {
    type: 'object',
    properties: {
      status: { type: 'string', example: 'success' },
      data: {
        type: 'object',
        properties: {
          breaker: { type: 'string', example: 'soroban' },
          state: { type: 'string', enum: ['closed', 'open', 'halfOpen'], example: 'closed' },
          errorRate: { type: 'number', example: 0 },
          volume: { type: 'integer', example: 12 },
        },
      },
    },
  },
  SocketMetricsResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      data: {
        type: 'object',
        properties: {
          connectedSockets: { type: 'integer', example: 8500 },
          totalConnections: { type: 'integer', example: 10000 },
          totalDisconnections: { type: 'integer', example: 1500 },
          messagesProcessed: { type: 'integer', example: 45000 },
          messageLatencyMs: {
            type: 'object',
            properties: {
              p50: { type: 'number', example: 12.5 },
              p95: { type: 'number', example: 45.3 },
              p99: { type: 'number', example: 98.7 },
            },
          },
          timestamp: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
  IndexerStatusResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      data: {
        type: 'object',
        properties: {
          lastProcessedLedger: { type: 'integer', example: 1234567 },
          latestLedger: { type: 'integer', example: 1234600 },
          lag: { type: 'integer', example: 33 },
          healthy: { type: 'boolean', example: true },
        },
      },
    },
  },
  EventLogEntry: {
    type: 'object',
    properties: {
      id: { type: 'string', example: '6512f1a2b3c4d5e6f7890abc' },
      eventType: { type: 'string', example: 'escrow_funded' },
      ledgerSequence: { type: 'integer', example: 123456 },
      transactionHash: { type: 'string', example: 'a1b2c3d4e5f6...' },
      processed: { type: 'boolean', example: true },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  StellarNetworkResponse: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      data: {
        type: 'object',
        properties: {
          network: { type: 'string', example: 'testnet' },
          passphrase: { type: 'string', example: 'Test SDF Network ; September 2015' },
          protocolVersion: { type: 'integer', example: 21 },
        },
      },
    },
  },

  // ─── Admin ──────────────────────────────────────────────────────────────────
  SuspendUserRequest: {
    type: 'object',
    required: ['reason'],
    properties: {
      reason: { type: 'string', example: 'Repeated policy violations' },
      ban: { type: 'boolean', example: false },
    },
  },
};

export default schemas;
