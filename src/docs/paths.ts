/**
 * OpenAPI 3.0 path operations for the SwiftChain Backend API.
 *
 * These are the endpoints that are not documented inline (via `@openapi`
 * JSDoc) in their route file. Together with the JSDoc blocks that
 * `swagger-jsdoc` scans from `src/routes/*.ts`, they make up the single
 * cohesive document assembled in `swagger.ts`.
 *
 * Every live route mounted from `src/routes/index.ts` appears exactly once —
 * here or in a route file. `tests/swagger.test.ts` asserts that invariant.
 */

import swaggerJSDoc from 'swagger-jsdoc';

const bearer = [{ bearerAuth: [] }];

export const paths: swaggerJSDoc.Paths = {
  // ─── Deliveries (extensions) ────────────────────────────────────────────────
  '/v1/deliveries/{id}/eta': {
    get: {
      tags: ['Deliveries'],
      summary: 'Estimate delivery arrival time',
      description:
        'Computes an ETA for a delivery from the driver’s live position and the routing service. Results are cached in Redis.',
      parameters: [
        {
          in: 'path',
          name: 'id',
          required: true,
          schema: { type: 'string' },
          description: 'Delivery ObjectId',
        },
        {
          in: 'query',
          name: 'refresh',
          required: false,
          schema: { type: 'boolean' },
          description: 'Bypass the cached ETA and recompute.',
        },
      ],
      responses: {
        200: {
          description: 'ETA computed successfully',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  data: {
                    type: 'object',
                    properties: {
                      etaMinutes: { type: 'number', example: 18 },
                      distanceMeters: { type: 'number', example: 4200 },
                      source: {
                        type: 'string',
                        enum: ['google', 'haversine'],
                        example: 'haversine',
                      },
                    },
                  },
                },
              },
            },
          },
        },
        404: { $ref: '#/components/responses/NotFound' },
      },
    },
  },
  '/v1/deliveries/bulk': {
    post: {
      tags: ['Deliveries'],
      summary: 'Batch-create deliveries from a CSV upload',
      description:
        'Accepts a multipart/form-data upload containing a single CSV file under the `file` field. Returns per-row success/error details.',
      security: bearer,
      requestBody: {
        required: true,
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object',
              required: ['file'],
              properties: { file: { type: 'string', format: 'binary' } },
            },
          },
        },
      },
      responses: {
        201: {
          description: 'Rows processed',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  data: {
                    type: 'object',
                    properties: {
                      created: { type: 'integer', example: 18 },
                      failed: { type: 'integer', example: 2 },
                      errors: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/BulkDeliveryRowError' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        400: { $ref: '#/components/responses/ValidationError' },
        401: { $ref: '#/components/responses/Unauthorized' },
      },
    },
  },
  '/v1/deliveries/{id}/assign-nearest-driver': {
    post: {
      tags: ['Deliveries'],
      summary: 'Assign the nearest available driver to a funded delivery',
      description:
        'Runs the proximity search and dispatches the closest available driver. Admin (dispatcher) only.',
      security: bearer,
      parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
      responses: {
        200: {
          description: 'Driver assigned',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  data: {
                    type: 'object',
                    properties: {
                      deliveryId: { type: 'string' },
                      driverId: { type: 'string' },
                      distanceMeters: { type: 'number', example: 1450 },
                    },
                  },
                },
              },
            },
          },
        },
        401: { $ref: '#/components/responses/Unauthorized' },
        403: { $ref: '#/components/responses/Forbidden' },
        404: { $ref: '#/components/responses/NotFound' },
        409: {
          description: 'Delivery is not in a state that can be assigned',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
          },
        },
      },
    },
  },
  '/v1/deliveries/{id}/proof-of-delivery': {
    post: {
      tags: ['Deliveries'],
      summary: 'Upload the proof-of-delivery image',
      description:
        'Accepts a multipart/form-data upload under the `file` field. Only the assigned driver or an admin may upload.',
      security: bearer,
      parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object',
              required: ['file'],
              properties: { file: { type: 'string', format: 'binary' } },
            },
          },
        },
      },
      responses: {
        201: {
          description: 'Proof of delivery stored',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  data: { $ref: '#/components/schemas/ProofOfDelivery' },
                },
              },
            },
          },
        },
        400: { $ref: '#/components/responses/ValidationError' },
        401: { $ref: '#/components/responses/Unauthorized' },
        403: { $ref: '#/components/responses/Forbidden' },
        404: { $ref: '#/components/responses/NotFound' },
      },
    },
    get: {
      tags: ['Deliveries'],
      summary: 'Fetch the proof of delivery for a delivery',
      security: bearer,
      parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
      responses: {
        200: {
          description: 'Proof of delivery retrieved',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  data: { $ref: '#/components/schemas/ProofOfDelivery' },
                },
              },
            },
          },
        },
        401: { $ref: '#/components/responses/Unauthorized' },
        404: { $ref: '#/components/responses/NotFound' },
      },
    },
  },

  // ─── Escrow ─────────────────────────────────────────────────────────────────
  '/v1/escrow/delivery/{deliveryId}': {
    get: {
      tags: ['Escrow'],
      summary: 'Get the escrow record for a delivery',
      security: bearer,
      parameters: [{ in: 'path', name: 'deliveryId', required: true, schema: { type: 'string' } }],
      responses: {
        200: {
          description: 'Escrow retrieved',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/EscrowResponse' } },
          },
        },
        401: { $ref: '#/components/responses/Unauthorized' },
        404: { $ref: '#/components/responses/NotFound' },
      },
    },
  },
  '/v1/escrow/contract/{contractId}': {
    get: {
      tags: ['Escrow'],
      summary: 'Get the escrow record for a contract id',
      security: bearer,
      parameters: [{ in: 'path', name: 'contractId', required: true, schema: { type: 'string' } }],
      responses: {
        200: {
          description: 'Escrow retrieved',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/EscrowResponse' } },
          },
        },
        401: { $ref: '#/components/responses/Unauthorized' },
        404: { $ref: '#/components/responses/NotFound' },
      },
    },
  },
  '/v1/escrow/sync': {
    post: {
      tags: ['Escrow'],
      summary: 'Manually trigger an escrow_funded indexer poll',
      security: bearer,
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/SyncEscrowRequest' } },
        },
      },
      responses: {
        200: {
          description: 'Events synced',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  data: {
                    type: 'object',
                    properties: {
                      latestLedger: { type: 'integer', example: 1234600 },
                      cursor: { type: 'string' },
                      processed: { type: 'integer', example: 3 },
                      ignored: { type: 'integer', example: 1 },
                    },
                  },
                },
              },
            },
          },
        },
        400: { $ref: '#/components/responses/ValidationError' },
        401: { $ref: '#/components/responses/Unauthorized' },
      },
    },
  },
  '/v1/escrow/release': {
    post: {
      tags: ['Escrow'],
      summary: 'Release an escrow',
      description:
        'Releases escrowed funds on-chain, guarded by a Redis distributed lock so concurrent requests cannot double-release.',
      security: bearer,
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/ReleaseEscrowRequest' } },
        },
      },
      responses: {
        200: {
          description: 'Escrow released',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/EscrowResponse' } },
          },
        },
        400: { $ref: '#/components/responses/ValidationError' },
        401: { $ref: '#/components/responses/Unauthorized' },
        404: { $ref: '#/components/responses/NotFound' },
        409: {
          description: 'Escrow already released or lock could not be acquired',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
          },
        },
      },
    },
  },

  // ─── Webhooks ───────────────────────────────────────────────────────────────
  '/v1/webhooks': {
    post: {
      tags: ['Webhooks'],
      summary: 'Register a webhook endpoint',
      description:
        'Merchant (enterprise) or admin only. The signing secret is returned once and never shown again.',
      security: bearer,
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/RegisterWebhookRequest' } },
        },
      },
      responses: {
        201: {
          description: 'Webhook registered',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  data: {
                    type: 'object',
                    properties: {
                      webhook: { $ref: '#/components/schemas/WebhookSubscription' },
                      secret: { type: 'string', example: 'whsec_...' },
                    },
                  },
                },
              },
            },
          },
        },
        400: { $ref: '#/components/responses/ValidationError' },
        401: { $ref: '#/components/responses/Unauthorized' },
        403: { $ref: '#/components/responses/Forbidden' },
      },
    },
    get: {
      tags: ['Webhooks'],
      summary: 'List the merchant’s webhook subscriptions',
      security: bearer,
      responses: {
        200: {
          description: 'Webhooks retrieved',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  data: {
                    type: 'object',
                    properties: {
                      webhooks: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/WebhookSubscription' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        401: { $ref: '#/components/responses/Unauthorized' },
      },
    },
  },
  '/v1/webhooks/{id}': {
    get: {
      tags: ['Webhooks'],
      summary: 'Get a webhook subscription',
      security: bearer,
      parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
      responses: {
        200: {
          description: 'Webhook retrieved',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/WebhookSubscription' },
            },
          },
        },
        401: { $ref: '#/components/responses/Unauthorized' },
        404: { $ref: '#/components/responses/NotFound' },
      },
    },
    patch: {
      tags: ['Webhooks'],
      summary: 'Update a webhook subscription',
      security: bearer,
      parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/UpdateWebhookRequest' } },
        },
      },
      responses: {
        200: {
          description: 'Webhook updated',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/WebhookSubscription' },
            },
          },
        },
        400: { $ref: '#/components/responses/ValidationError' },
        401: { $ref: '#/components/responses/Unauthorized' },
        404: { $ref: '#/components/responses/NotFound' },
      },
    },
    delete: {
      tags: ['Webhooks'],
      summary: 'Delete a webhook subscription',
      security: bearer,
      parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
      responses: {
        200: { description: 'Webhook deleted' },
        401: { $ref: '#/components/responses/Unauthorized' },
        404: { $ref: '#/components/responses/NotFound' },
      },
    },
  },
  '/v1/webhooks/{id}/rotate-secret': {
    post: {
      tags: ['Webhooks'],
      summary: 'Rotate a webhook signing secret',
      description: 'Issues a new HMAC secret and invalidates the previous one.',
      security: bearer,
      parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
      responses: {
        200: {
          description: 'Secret rotated',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  data: {
                    type: 'object',
                    properties: {
                      webhook: { $ref: '#/components/schemas/WebhookSubscription' },
                      secret: { type: 'string', example: 'whsec_...' },
                    },
                  },
                },
              },
            },
          },
        },
        401: { $ref: '#/components/responses/Unauthorized' },
        404: { $ref: '#/components/responses/NotFound' },
      },
    },
  },

  // ─── Fleets ─────────────────────────────────────────────────────────────────
  '/v1/fleets': {
    post: {
      tags: ['Fleets'],
      summary: 'Create a fleet',
      security: bearer,
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/CreateFleetRequest' } },
        },
      },
      responses: {
        201: {
          description: 'Fleet created',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  data: {
                    type: 'object',
                    properties: { fleet: { $ref: '#/components/schemas/Fleet' } },
                  },
                },
              },
            },
          },
        },
        400: { $ref: '#/components/responses/ValidationError' },
        401: { $ref: '#/components/responses/Unauthorized' },
        403: { $ref: '#/components/responses/Forbidden' },
      },
    },
    get: {
      tags: ['Fleets'],
      summary: 'List fleets (paginated)',
      security: bearer,
      parameters: [
        { in: 'query', name: 'page', schema: { type: 'integer', default: 1 } },
        { in: 'query', name: 'limit', schema: { type: 'integer', default: 10 } },
      ],
      responses: {
        200: {
          description: 'Fleets retrieved',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  data: {
                    type: 'object',
                    properties: {
                      fleets: { type: 'array', items: { $ref: '#/components/schemas/Fleet' } },
                      pagination: { $ref: '#/components/schemas/PaginationMeta' },
                    },
                  },
                },
              },
            },
          },
        },
        401: { $ref: '#/components/responses/Unauthorized' },
      },
    },
  },
  '/v1/fleets/{id}': {
    get: {
      tags: ['Fleets'],
      summary: 'Get a fleet by id',
      security: bearer,
      parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
      responses: {
        200: {
          description: 'Fleet retrieved',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  data: {
                    type: 'object',
                    properties: { fleet: { $ref: '#/components/schemas/Fleet' } },
                  },
                },
              },
            },
          },
        },
        400: { $ref: '#/components/responses/ValidationError' },
        401: { $ref: '#/components/responses/Unauthorized' },
        404: { $ref: '#/components/responses/NotFound' },
      },
    },
    put: {
      tags: ['Fleets'],
      summary: 'Update a fleet',
      description: 'Fleet owner only.',
      security: bearer,
      parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/CreateFleetRequest' } },
        },
      },
      responses: {
        200: {
          description: 'Fleet updated',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  data: {
                    type: 'object',
                    properties: { fleet: { $ref: '#/components/schemas/Fleet' } },
                  },
                },
              },
            },
          },
        },
        401: { $ref: '#/components/responses/Unauthorized' },
        403: { $ref: '#/components/responses/Forbidden' },
        404: { $ref: '#/components/responses/NotFound' },
      },
    },
    delete: {
      tags: ['Fleets'],
      summary: 'Soft-delete a fleet',
      description: 'Fleet owner only.',
      security: bearer,
      parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
      responses: {
        200: { description: 'Fleet deleted' },
        401: { $ref: '#/components/responses/Unauthorized' },
        403: { $ref: '#/components/responses/Forbidden' },
        404: { $ref: '#/components/responses/NotFound' },
      },
    },
  },
  '/v1/fleets/{id}/members': {
    post: {
      tags: ['Fleets'],
      summary: 'Add a member to a fleet',
      security: bearer,
      parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['userId'],
              properties: {
                userId: { type: 'string', example: '6512f1a2b3c4d5e6f7890abc' },
                role: { type: 'string', enum: ['admin', 'driver', 'viewer'], example: 'driver' },
              },
            },
          },
        },
      },
      responses: {
        201: {
          description: 'Member added',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  data: {
                    type: 'object',
                    properties: { fleet: { $ref: '#/components/schemas/Fleet' } },
                  },
                },
              },
            },
          },
        },
        400: { $ref: '#/components/responses/ValidationError' },
        401: { $ref: '#/components/responses/Unauthorized' },
        403: { $ref: '#/components/responses/Forbidden' },
        404: { $ref: '#/components/responses/NotFound' },
        409: {
          description: 'User is already a member',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
          },
        },
      },
    },
  },
  '/v1/fleets/{id}/members/{userId}': {
    delete: {
      tags: ['Fleets'],
      summary: 'Remove a member from a fleet',
      security: bearer,
      parameters: [
        { in: 'path', name: 'id', required: true, schema: { type: 'string' } },
        { in: 'path', name: 'userId', required: true, schema: { type: 'string' } },
      ],
      responses: {
        200: { description: 'Member removed' },
        400: { $ref: '#/components/responses/ValidationError' },
        401: { $ref: '#/components/responses/Unauthorized' },
        403: { $ref: '#/components/responses/Forbidden' },
        404: { $ref: '#/components/responses/NotFound' },
      },
    },
  },
  '/v1/fleets/{id}/invite': {
    post: {
      tags: ['Fleets'],
      summary: 'Invite a driver to a fleet',
      security: bearer,
      parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['driverId'],
              properties: { driverId: { type: 'string', example: '6512f1a2b3c4d5e6f7890abc' } },
            },
          },
        },
      },
      responses: {
        201: {
          description: 'Invitation sent',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  data: {
                    type: 'object',
                    properties: { invitation: { $ref: '#/components/schemas/FleetInvitation' } },
                  },
                },
              },
            },
          },
        },
        400: { $ref: '#/components/responses/ValidationError' },
        401: { $ref: '#/components/responses/Unauthorized' },
        403: { $ref: '#/components/responses/Forbidden' },
      },
    },
  },
  '/v1/fleets/invitations/{invitationId}': {
    patch: {
      tags: ['Fleets'],
      summary: 'Accept or decline a fleet invitation',
      security: bearer,
      parameters: [
        { in: 'path', name: 'invitationId', required: true, schema: { type: 'string' } },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['accept'],
              properties: { accept: { type: 'boolean', example: true } },
            },
          },
        },
      },
      responses: {
        200: {
          description: 'Invitation responded to',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  data: {
                    type: 'object',
                    properties: { invitation: { $ref: '#/components/schemas/FleetInvitation' } },
                  },
                },
              },
            },
          },
        },
        400: { $ref: '#/components/responses/ValidationError' },
        401: { $ref: '#/components/responses/Unauthorized' },
        403: { $ref: '#/components/responses/Forbidden' },
        404: { $ref: '#/components/responses/NotFound' },
      },
    },
  },
  '/v1/fleets/{id}/metrics': {
    get: {
      tags: ['Fleets'],
      summary: 'Get aggregated fleet metrics',
      security: bearer,
      parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
      responses: {
        200: {
          description: 'Metrics retrieved',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  data: {
                    type: 'object',
                    properties: { metrics: { $ref: '#/components/schemas/FleetMetrics' } },
                  },
                },
              },
            },
          },
        },
        401: { $ref: '#/components/responses/Unauthorized' },
        403: { $ref: '#/components/responses/Forbidden' },
        404: { $ref: '#/components/responses/NotFound' },
      },
    },
  },

  // ─── Disputes ───────────────────────────────────────────────────────────────
  '/v1/disputes': {
    post: {
      tags: ['Disputes'],
      summary: 'Open a dispute',
      security: bearer,
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/CreateDisputeRequest' } },
        },
      },
      responses: {
        201: {
          description: 'Dispute opened',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  data: {
                    type: 'object',
                    properties: { dispute: { $ref: '#/components/schemas/Dispute' } },
                  },
                },
              },
            },
          },
        },
        400: { $ref: '#/components/responses/ValidationError' },
        401: { $ref: '#/components/responses/Unauthorized' },
      },
    },
    get: {
      tags: ['Disputes'],
      summary: 'List disputes',
      security: bearer,
      parameters: [
        {
          in: 'query',
          name: 'status',
          schema: { type: 'string', enum: ['open', 'under_review', 'resolved', 'rejected'] },
        },
        { in: 'query', name: 'raisedBy', schema: { type: 'string' } },
        { in: 'query', name: 'deliveryId', schema: { type: 'string' } },
        { in: 'query', name: 'page', schema: { type: 'integer', default: 1 } },
        { in: 'query', name: 'limit', schema: { type: 'integer', default: 10 } },
      ],
      responses: {
        200: {
          description: 'Disputes retrieved',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  data: {
                    type: 'object',
                    properties: {
                      disputes: { type: 'array', items: { $ref: '#/components/schemas/Dispute' } },
                      meta: { $ref: '#/components/schemas/PaginationMeta' },
                    },
                  },
                },
              },
            },
          },
        },
        401: { $ref: '#/components/responses/Unauthorized' },
      },
    },
  },
  '/v1/disputes/{id}': {
    get: {
      tags: ['Disputes'],
      summary: 'Get a dispute by id',
      security: bearer,
      parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
      responses: {
        200: {
          description: 'Dispute retrieved',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  data: {
                    type: 'object',
                    properties: { dispute: { $ref: '#/components/schemas/Dispute' } },
                  },
                },
              },
            },
          },
        },
        401: { $ref: '#/components/responses/Unauthorized' },
        404: { $ref: '#/components/responses/NotFound' },
      },
    },
    patch: {
      tags: ['Disputes'],
      summary: 'Update dispute metadata',
      security: bearer,
      parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/UpdateDisputeRequest' } },
        },
      },
      responses: {
        200: {
          description: 'Dispute updated',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  data: {
                    type: 'object',
                    properties: { dispute: { $ref: '#/components/schemas/Dispute' } },
                  },
                },
              },
            },
          },
        },
        400: { $ref: '#/components/responses/ValidationError' },
        401: { $ref: '#/components/responses/Unauthorized' },
        404: { $ref: '#/components/responses/NotFound' },
      },
    },
  },
  '/v1/disputes/{id}/evidence': {
    patch: {
      tags: ['Disputes'],
      summary: 'Add evidence URLs to a dispute',
      security: bearer,
      parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/AddEvidenceRequest' } },
        },
      },
      responses: {
        200: {
          description: 'Evidence added',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  data: {
                    type: 'object',
                    properties: { dispute: { $ref: '#/components/schemas/Dispute' } },
                  },
                },
              },
            },
          },
        },
        400: { $ref: '#/components/responses/ValidationError' },
        401: { $ref: '#/components/responses/Unauthorized' },
        404: { $ref: '#/components/responses/NotFound' },
      },
    },
  },
  '/v1/disputes/{id}/resolve': {
    patch: {
      tags: ['Disputes'],
      summary: 'Resolve or reject a dispute',
      security: bearer,
      parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/ResolveDisputeRequest' } },
        },
      },
      responses: {
        200: {
          description: 'Dispute resolved',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  data: {
                    type: 'object',
                    properties: { dispute: { $ref: '#/components/schemas/Dispute' } },
                  },
                },
              },
            },
          },
        },
        400: { $ref: '#/components/responses/ValidationError' },
        401: { $ref: '#/components/responses/Unauthorized' },
        403: { $ref: '#/components/responses/Forbidden' },
        404: { $ref: '#/components/responses/NotFound' },
      },
    },
  },

  // ─── Indexer ────────────────────────────────────────────────────────────────
  '/v1/indexer/status': {
    get: {
      tags: ['Indexer'],
      summary: 'Get indexer status',
      description: 'Reports the last processed ledger and the current chain lag.',
      responses: {
        200: {
          description: 'Indexer status retrieved',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/IndexerStatusResponse' } },
          },
        },
      },
    },
  },

  // ─── Notifications ──────────────────────────────────────────────────────────
  '/v1/notifications': {
    get: {
      tags: ['Notifications'],
      summary: 'List the authenticated user’s notifications',
      security: bearer,
      parameters: [
        { in: 'query', name: 'page', schema: { type: 'integer', default: 1 } },
        { in: 'query', name: 'limit', schema: { type: 'integer', default: 20, maximum: 100 } },
      ],
      responses: {
        200: {
          description: 'Notifications retrieved',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { type: 'array', items: { $ref: '#/components/schemas/Notification' } },
                  pagination: { $ref: '#/components/schemas/PaginationMeta' },
                },
              },
            },
          },
        },
        401: { $ref: '#/components/responses/Unauthorized' },
      },
    },
  },
  '/v1/notifications/preferences': {
    get: {
      tags: ['Notifications'],
      summary: 'Get notification preferences',
      security: bearer,
      responses: {
        200: {
          description: 'Preferences retrieved',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { $ref: '#/components/schemas/NotificationPreference' },
                },
              },
            },
          },
        },
        401: { $ref: '#/components/responses/Unauthorized' },
      },
    },
    patch: {
      tags: ['Notifications'],
      summary: 'Update notification preferences',
      security: bearer,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/UpdateNotificationPreferencesRequest' },
          },
        },
      },
      responses: {
        200: {
          description: 'Preferences updated',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { $ref: '#/components/schemas/NotificationPreference' },
                },
              },
            },
          },
        },
        400: { $ref: '#/components/responses/ValidationError' },
        401: { $ref: '#/components/responses/Unauthorized' },
      },
    },
  },
  '/v1/notifications/devices': {
    post: {
      tags: ['Notifications'],
      summary: 'Register a device push token',
      security: bearer,
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/RegisterDeviceRequest' } },
        },
      },
      responses: {
        201: {
          description: 'Device registered',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { $ref: '#/components/schemas/NotificationPreference' },
                },
              },
            },
          },
        },
        400: { $ref: '#/components/responses/ValidationError' },
        401: { $ref: '#/components/responses/Unauthorized' },
      },
    },
    delete: {
      tags: ['Notifications'],
      summary: 'Remove a device push token',
      security: bearer,
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/UnregisterDeviceRequest' } },
        },
      },
      responses: {
        200: {
          description: 'Device unregistered',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'success' },
                  data: { $ref: '#/components/schemas/NotificationPreference' },
                },
              },
            },
          },
        },
        400: { $ref: '#/components/responses/ValidationError' },
        401: { $ref: '#/components/responses/Unauthorized' },
      },
    },
  },

  // ─── Drivers ────────────────────────────────────────────────────────────────
  '/v1/drivers/leaderboard': {
    get: {
      tags: ['Drivers'],
      summary: 'Get the driver leaderboard',
      description: 'Drivers ranked by reputation points, highest first.',
      parameters: [
        { in: 'query', name: 'page', schema: { type: 'integer', default: 1 } },
        { in: 'query', name: 'limit', schema: { type: 'integer', default: 20, maximum: 100 } },
      ],
      responses: {
        200: {
          description: 'Leaderboard retrieved',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  data: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/LeaderboardEntry' },
                  },
                  message: { type: 'string', example: 'Leaderboard retrieved successfully' },
                },
              },
            },
          },
        },
      },
    },
  },
  '/v1/drivers/me/vehicle': {
    patch: {
      tags: ['Drivers'],
      summary: 'Create or update the authenticated driver’s vehicle details',
      security: bearer,
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/SetVehicleDetailsRequest' } },
        },
      },
      responses: {
        200: {
          description: 'Vehicle details updated',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  data: {
                    type: 'object',
                    properties: {
                      profile: {
                        type: 'object',
                        properties: {
                          userId: { type: 'string' },
                          vehicleDetails: { $ref: '#/components/schemas/VehicleDetails' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        400: { $ref: '#/components/responses/ValidationError' },
        401: { $ref: '#/components/responses/Unauthorized' },
        403: { $ref: '#/components/responses/Forbidden' },
      },
    },
  },
  '/v1/drivers/nearby': {
    get: {
      tags: ['Drivers'],
      summary: 'Find drivers near a coordinate',
      security: bearer,
      parameters: [
        { in: 'query', name: 'lat', required: true, schema: { type: 'number', example: 6.5244 } },
        { in: 'query', name: 'lng', required: true, schema: { type: 'number', example: 3.3792 } },
        { in: 'query', name: 'radiusMeters', schema: { type: 'number', example: 5000 } },
        { in: 'query', name: 'limit', schema: { type: 'integer', example: 20 } },
      ],
      responses: {
        200: {
          description: 'Nearby drivers retrieved',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  data: {
                    type: 'object',
                    properties: {
                      drivers: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            driverId: { type: 'string' },
                            distanceMeters: { type: 'number', example: 820 },
                            lat: { type: 'number' },
                            lng: { type: 'number' },
                            isAvailable: { type: 'boolean' },
                          },
                        },
                      },
                      count: { type: 'integer', example: 3 },
                      radiusMeters: { type: 'number', example: 5000 },
                    },
                  },
                },
              },
            },
          },
        },
        400: { $ref: '#/components/responses/ValidationError' },
        401: { $ref: '#/components/responses/Unauthorized' },
      },
    },
  },
  '/v1/drivers/nearby/explain': {
    get: {
      tags: ['Drivers'],
      summary: 'Explain the proximity query plan',
      description: 'Admin-only diagnostic reporting the index chosen by the planner.',
      security: bearer,
      parameters: [
        { in: 'query', name: 'lat', required: true, schema: { type: 'number' } },
        { in: 'query', name: 'lng', required: true, schema: { type: 'number' } },
      ],
      responses: {
        200: { description: 'Query plan summary' },
        401: { $ref: '#/components/responses/Unauthorized' },
        403: { $ref: '#/components/responses/Forbidden' },
      },
    },
  },
  '/v1/drivers/me/location': {
    put: {
      tags: ['Drivers'],
      summary: 'Record the authenticated driver’s location',
      security: bearer,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/UpdateDriverLocationRequest' },
          },
        },
      },
      responses: {
        200: { description: 'Location recorded' },
        400: { $ref: '#/components/responses/ValidationError' },
        401: { $ref: '#/components/responses/Unauthorized' },
        403: { $ref: '#/components/responses/Forbidden' },
      },
    },
  },
  '/v1/drivers/{driverId}/location': {
    get: {
      tags: ['Drivers'],
      summary: 'Get a driver’s most recent location',
      security: bearer,
      parameters: [{ in: 'path', name: 'driverId', required: true, schema: { type: 'string' } }],
      responses: {
        200: { description: 'Location retrieved' },
        401: { $ref: '#/components/responses/Unauthorized' },
        404: { $ref: '#/components/responses/NotFound' },
      },
    },
  },
  '/v1/drivers/{id}/earnings': {
    get: {
      tags: ['Drivers'],
      summary: 'Aggregate a driver’s earnings',
      description:
        'Aggregates released escrows by day, week or month. A driver may only view their own earnings; an admin may view any.',
      security: bearer,
      parameters: [
        { in: 'path', name: 'id', required: true, schema: { type: 'string' } },
        {
          in: 'query',
          name: 'groupBy',
          schema: { type: 'string', enum: ['day', 'week', 'month'] },
        },
        { in: 'query', name: 'startDate', schema: { type: 'string', format: 'date' } },
        { in: 'query', name: 'endDate', schema: { type: 'string', format: 'date' } },
      ],
      responses: {
        200: {
          description: 'Earnings retrieved',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  data: {
                    type: 'object',
                    properties: {
                      driverId: { type: 'string' },
                      groupBy: { type: 'string', enum: ['day', 'week', 'month'] },
                      periods: { type: 'array', items: { type: 'object' } },
                      summary: { type: 'object' },
                    },
                  },
                },
              },
            },
          },
        },
        400: { $ref: '#/components/responses/ValidationError' },
        401: { $ref: '#/components/responses/Unauthorized' },
        403: { $ref: '#/components/responses/Forbidden' },
      },
    },
  },

  // ─── Profile ────────────────────────────────────────────────────────────────
  '/v1/profile': {
    get: {
      tags: ['Profile'],
      summary: 'Get the authenticated user’s profile',
      security: bearer,
      responses: {
        200: {
          description: 'Profile retrieved',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ProfileResponse' } },
          },
        },
        401: { $ref: '#/components/responses/Unauthorized' },
      },
    },
  },
  '/v1/profile/picture': {
    post: {
      tags: ['Profile'],
      summary: 'Upload or replace the profile picture',
      security: bearer,
      requestBody: {
        required: true,
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object',
              required: ['profilePicture'],
              properties: { profilePicture: { type: 'string', format: 'binary' } },
            },
          },
        },
      },
      responses: {
        200: {
          description: 'Picture uploaded',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ProfilePictureResponse' },
            },
          },
        },
        400: { $ref: '#/components/responses/ValidationError' },
        401: { $ref: '#/components/responses/Unauthorized' },
      },
    },
    delete: {
      tags: ['Profile'],
      summary: 'Remove the profile picture',
      security: bearer,
      responses: {
        200: { description: 'Picture removed' },
        401: { $ref: '#/components/responses/Unauthorized' },
        404: { $ref: '#/components/responses/NotFound' },
      },
    },
  },

  // ─── Users ──────────────────────────────────────────────────────────────────
  '/v1/users/wallet': {
    put: {
      tags: ['Users'],
      summary: 'Link or update the Stellar wallet address',
      security: bearer,
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/UpdateWalletRequest' } },
        },
      },
      responses: {
        200: { description: 'Wallet updated' },
        400: { $ref: '#/components/responses/ValidationError' },
        401: { $ref: '#/components/responses/Unauthorized' },
      },
    },
  },
  '/v1/users/deleted': {
    get: {
      tags: ['Users'],
      summary: 'List soft-deleted users',
      description: 'Admin only.',
      security: bearer,
      responses: {
        200: { description: 'Deleted users retrieved' },
        401: { $ref: '#/components/responses/Unauthorized' },
        403: { $ref: '#/components/responses/Forbidden' },
      },
    },
  },
  '/v1/users/{id}': {
    get: {
      tags: ['Users'],
      summary: 'Get a user by id',
      security: bearer,
      parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
      responses: {
        200: { description: 'User retrieved' },
        401: { $ref: '#/components/responses/Unauthorized' },
        404: { $ref: '#/components/responses/NotFound' },
      },
    },
    put: {
      tags: ['Users'],
      summary: 'Update a user',
      description: 'Admin only.',
      security: bearer,
      parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/UpdateUserRequest' } },
        },
      },
      responses: {
        200: { description: 'User updated' },
        400: { $ref: '#/components/responses/ValidationError' },
        401: { $ref: '#/components/responses/Unauthorized' },
        403: { $ref: '#/components/responses/Forbidden' },
        404: { $ref: '#/components/responses/NotFound' },
      },
    },
    delete: {
      tags: ['Users'],
      summary: 'Soft-delete a user',
      description: 'Admin only. Cascades to related records.',
      security: bearer,
      parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
      responses: {
        200: { description: 'User deleted' },
        401: { $ref: '#/components/responses/Unauthorized' },
        403: { $ref: '#/components/responses/Forbidden' },
        404: { $ref: '#/components/responses/NotFound' },
      },
    },
  },
  '/v1/users/{id}/restore': {
    post: {
      tags: ['Users'],
      summary: 'Restore a soft-deleted user',
      description: 'Admin only.',
      security: bearer,
      parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
      responses: {
        200: { description: 'User restored' },
        401: { $ref: '#/components/responses/Unauthorized' },
        403: { $ref: '#/components/responses/Forbidden' },
        404: { $ref: '#/components/responses/NotFound' },
      },
    },
  },
  '/v1/users/{id}/password': {
    put: {
      tags: ['Users'],
      summary: 'Update a user’s password',
      description: 'The authenticated user may only change their own password.',
      security: bearer,
      parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/UpdatePasswordRequest' } },
        },
      },
      responses: {
        200: { description: 'Password updated' },
        400: { $ref: '#/components/responses/ValidationError' },
        401: { $ref: '#/components/responses/Unauthorized' },
        403: { $ref: '#/components/responses/Forbidden' },
      },
    },
  },

  // ─── Monitor ────────────────────────────────────────────────────────────────
  '/v1/monitor/indexer-lag': {
    get: {
      tags: ['Monitoring'],
      summary: 'Run an on-demand indexer-lag check',
      description: 'Admin only.',
      security: bearer,
      responses: {
        200: {
          description: 'Lag status retrieved',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/IndexerStatusResponse' } },
          },
        },
        401: { $ref: '#/components/responses/Unauthorized' },
        403: { $ref: '#/components/responses/Forbidden' },
      },
    },
  },
  '/v1/monitor/indexer-lag/alerts': {
    get: {
      tags: ['Monitoring'],
      summary: 'List recent indexer-lag alerts',
      description: 'Admin only.',
      security: bearer,
      responses: {
        200: { description: 'Alerts retrieved' },
        401: { $ref: '#/components/responses/Unauthorized' },
        403: { $ref: '#/components/responses/Forbidden' },
      },
    },
  },

  // ─── Event log ──────────────────────────────────────────────────────────────
  '/v1/eventlog/last-processed': {
    get: {
      tags: ['Indexer'],
      summary: 'Get the last processed ledger',
      security: bearer,
      responses: {
        200: { description: 'Last processed ledger retrieved' },
        401: { $ref: '#/components/responses/Unauthorized' },
      },
    },
  },
  '/v1/eventlog/unprocessed': {
    get: {
      tags: ['Indexer'],
      summary: 'List unprocessed events',
      description: 'Admin or enterprise only.',
      security: bearer,
      responses: {
        200: {
          description: 'Unprocessed events retrieved',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  data: { type: 'array', items: { $ref: '#/components/schemas/EventLogEntry' } },
                },
              },
            },
          },
        },
        401: { $ref: '#/components/responses/Unauthorized' },
        403: { $ref: '#/components/responses/Forbidden' },
      },
    },
  },
  '/v1/eventlog/range': {
    get: {
      tags: ['Indexer'],
      summary: 'List events in a ledger range',
      description: 'Admin or enterprise only.',
      security: bearer,
      parameters: [
        { in: 'query', name: 'from', required: true, schema: { type: 'integer' } },
        { in: 'query', name: 'to', required: true, schema: { type: 'integer' } },
      ],
      responses: {
        200: { description: 'Events retrieved' },
        400: { $ref: '#/components/responses/ValidationError' },
        401: { $ref: '#/components/responses/Unauthorized' },
        403: { $ref: '#/components/responses/Forbidden' },
      },
    },
  },
  '/v1/eventlog/transaction/{hash}': {
    get: {
      tags: ['Indexer'],
      summary: 'Get an event by transaction hash',
      security: bearer,
      parameters: [{ in: 'path', name: 'hash', required: true, schema: { type: 'string' } }],
      responses: {
        200: { description: 'Event retrieved' },
        401: { $ref: '#/components/responses/Unauthorized' },
        404: { $ref: '#/components/responses/NotFound' },
      },
    },
  },

  // ─── Uploads / evidence ─────────────────────────────────────────────────────
  '/v1/uploads/evidence': {
    post: {
      tags: ['Uploads'],
      summary: 'Upload media evidence for a dispute',
      security: bearer,
      requestBody: {
        required: true,
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object',
              required: ['file', 'disputeId'],
              properties: {
                file: { type: 'string', format: 'binary' },
                disputeId: { type: 'string' },
              },
            },
          },
        },
      },
      responses: {
        201: { description: 'Evidence stored' },
        400: { $ref: '#/components/responses/ValidationError' },
        401: { $ref: '#/components/responses/Unauthorized' },
        415: { description: 'Unsupported media type' },
      },
    },
  },
  '/v1/uploads/evidence/{disputeId}': {
    get: {
      tags: ['Uploads'],
      summary: 'List evidence linked to a dispute',
      security: bearer,
      parameters: [{ in: 'path', name: 'disputeId', required: true, schema: { type: 'string' } }],
      responses: {
        200: { description: 'Evidence retrieved' },
        401: { $ref: '#/components/responses/Unauthorized' },
      },
    },
  },

  // ─── Stellar / Soroban ──────────────────────────────────────────────────────
  '/v1/stellar/health': {
    get: {
      tags: ['Health'],
      summary: 'Check Stellar RPC connectivity',
      responses: {
        200: { description: 'RPC reachable' },
        503: { description: 'RPC unreachable' },
      },
    },
  },
  '/v1/stellar/network': {
    get: {
      tags: ['Health'],
      summary: 'Get Stellar network information',
      responses: {
        200: {
          description: 'Network info retrieved',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/StellarNetworkResponse' } },
          },
        },
      },
    },
  },
  '/v1/stellar/ledger/latest': {
    get: {
      tags: ['Health'],
      summary: 'Get the latest ledger sequence',
      responses: {
        200: { description: 'Latest ledger retrieved' },
        503: { description: 'RPC unreachable' },
      },
    },
  },

  // ─── Transactions ───────────────────────────────────────────────────────────
  '/v1/transactions/escrow-lock': {
    post: {
      tags: ['Transactions'],
      summary: 'Build an unsigned escrow-lock transaction',
      description:
        'Builds an unsigned Soroban XDR that locks a delivery’s escrow amount for the client to sign.',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['deliveryId', 'payerAddress'],
              properties: {
                deliveryId: { type: 'string', example: '6512f1a2b3c4d5e6f7890abc' },
                payerAddress: {
                  type: 'string',
                  example: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
                },
              },
            },
          },
        },
      },
      responses: {
        200: {
          description: 'Unsigned XDR built',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  data: {
                    type: 'object',
                    properties: { xdr: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
        400: { $ref: '#/components/responses/ValidationError' },
        404: { $ref: '#/components/responses/NotFound' },
        503: { description: 'Escrow contract not configured' },
      },
    },
  },
};

export default paths;
