import path from 'path';
import swaggerJSDoc from 'swagger-jsdoc';
import env from '../config/env';
import { schemas } from './schemas';
import { paths } from './paths';

/**
 * OpenAPI 3.0.3 definition for the SwiftChain Backend API.
 *
 * The document is assembled from three sources so every live endpoint is
 * documented exactly once:
 *
 *   1. `components` — reusable schemas shared across operations, defined in
 *      `src/docs/schemas.ts` and applied to protected endpoints through the
 *      `bearerAuth` security scheme.
 *   2. `paths` — endpoint groups that are not annotated inline, defined in
 *      `src/docs/paths.ts`.
 *   3. Route-level `@openapi` JSDoc blocks — scanned from the route files
 *      listed in the `apis` glob below (auth, deliveries, admin, escrow,
 *      indexer, health, socket metrics and transactions).
 *
 * Together these cover every route mounted from `src/routes/index.ts`; that
 * invariant is asserted by `tests/swagger.test.ts`.
 */
const swaggerDefinition: swaggerJSDoc.SwaggerDefinition = {
  openapi: '3.0.3',
  info: {
    title: 'SwiftChain Backend API',
    version: '1.0.0',
    description:
      'REST API for the SwiftChain delivery platform: authentication and account ' +
      'management, the delivery lifecycle (creation, status tracking, proof of ' +
      'delivery and bulk import), Stellar/Soroban escrow, merchant webhooks, ' +
      'fleets, disputes, driver locations, ratings and earnings, notifications, ' +
      'the chain indexer, and administrative tooling.',
  },
  servers: [
    {
      url: `http://localhost:${env.PORT}/api`,
      description: `${env.NODE_ENV} server`,
    },
  ],
  tags: [
    { name: 'Auth', description: 'User registration and authentication' },
    { name: 'Deliveries', description: 'Delivery creation, lifecycle, and archival' },
    { name: 'Delivery Status', description: 'Driver-facing delivery status transitions' },
    { name: 'Escrow', description: 'Soroban escrow funding, release and sync' },
    { name: 'Webhooks', description: 'Merchant webhook subscriptions and secrets' },
    { name: 'Fleets', description: 'Fleet creation, membership, invitations and metrics' },
    { name: 'Disputes', description: 'Dispute creation, evidence and resolution' },
    { name: 'Drivers', description: 'Driver location, ratings, earnings and leaderboard' },
    { name: 'Notifications', description: 'Push notification history, preferences and devices' },
    { name: 'Profile', description: 'Authenticated user profile and profile picture' },
    { name: 'Users', description: 'User administration and wallet linking' },
    { name: 'Indexer', description: 'Chain indexer status and processed event log' },
    { name: 'Monitoring', description: 'Health, metrics and operational diagnostics' },
    { name: 'Health', description: 'Liveness and Stellar/Soroban connectivity checks' },
    { name: 'Transactions', description: 'Soroban transaction building and submission' },
    { name: 'Uploads', description: 'Evidence and media uploads' },
    { name: 'Admin', description: 'Administrative dashboards, disputes and DLQ management' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      },
    },
    schemas,
    responses: {
      Unauthorized: {
        description: 'Missing, malformed, invalid, or expired authorization token',
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
        },
      },
      Forbidden: {
        description: 'Authenticated but not permitted to perform this action',
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
        },
      },
      NotFound: {
        description: 'Resource not found',
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
        },
      },
      ValidationError: {
        description: 'Request failed validation',
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/ValidationErrorResponse' } },
        },
      },
    },
  },
  // Endpoint groups that are not annotated inline in their route file.
  paths,
};

// swagger-jsdoc parses comments straight out of the route source files, so
// point it at compiled .js when running from dist/ (comments are stripped
// by tsc) and at .ts when running under ts-node/ts-jest in development.
// path.join is required here (rather than string templating) so the glob
// swagger-jsdoc builds internally uses consistent path separators on Windows.
const routeFileExtension = __filename.endsWith('.ts') ? 'ts' : 'js';
const routesDir = path.join(__dirname, '..', 'routes');

/**
 * Route files that carry `@openapi` JSDoc annotations. Each contributes its
 * own paths to the final document; everything else lives in `paths.ts`.
 */
const annotatedRouteFiles = [
  'authRoutes',
  'delivery.routes',
  'deliveries',
  'driverRoutes',
  'adminRoutes',
  'escrow.routes',
  'escrowIndexer.routes',
  'indexer.routes',
  'healthRoutes',
  'socketMetricsRoutes',
  'transactionRoutes',
];

const swaggerOptions: swaggerJSDoc.Options = {
  definition: swaggerDefinition,
  apis: annotatedRouteFiles.map((file) => path.join(routesDir, `${file}.${routeFileExtension}`)),
};

const swaggerSpec = swaggerJSDoc(swaggerOptions);

export default swaggerSpec;
