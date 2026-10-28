# Contributor Walkthrough: Add a New API Endpoint

This walkthrough demonstrates how to add a versioned endpoint through the SwiftChain Backend request stack.

Example endpoint:

```text
GET /api/v1/sample
```

The example follows the project's existing architecture:

```text
Route
  ↓
Controller
  ↓
Service
  ↓
Repository
  ↓
Model
```

Validation, query middleware, dependency registration, OpenAPI documentation, and tests are included around that stack.

---

## 1. Create the Route

Use:

```text
src/routes/webhookRoutes.ts
```

as the route-registration pattern.

Create:

```text
src/routes/sampleRoutes.ts
```

Example:

```typescript
import { Router } from 'express';
import { sampleController } from '../controllers/sampleController';

const router = Router();

router.get('/', sampleController.getSample.bind(sampleController));

export default router;
```

The router should contain the resource-relative path only:

```text
/
```

The API version prefix is added when the router is mounted.

---

## 2. Create the Controller

Create:

```text
src/controllers/sampleController.ts
```

The controller should handle HTTP concerns and delegate business logic to the service.

Example:

```typescript
import { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../utils/responseWrapper';
import { sampleService } from '../services/sampleService';

export class SampleController {
  async getSample(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await sampleService.getSample();

      sendSuccess(res, result, 'Sample retrieved successfully');
    } catch (error) {
      next(error);
    }
  }
}

export const sampleController = new SampleController();
```

Use the project's canonical response wrapper:

```text
src/utils/responseWrapper.ts
```

Do not return an unrelated response shape.

The standard success envelope is:

```json
{
  "success": true,
  "data": {},
  "error": null,
  "message": "Sample retrieved successfully"
}
```

---

## 3. Create the Service

Create:

```text
src/services/sampleService.ts
```

Example:

```typescript
import { sampleRepository } from '../repositories/sampleRepository';

export class SampleService {
  async getSample() {
    return sampleRepository.findSample();
  }
}

export const sampleService = new SampleService();
```

Business rules belong in the service rather than in the route.

Keep controllers focused on HTTP handling.

---

## 4. Create the Repository

Follow:

```text
src/repositories/BaseRepository.ts
```

for the shared repository abstraction.

Create:

```text
src/repositories/sampleRepository.ts
```

Example:

```typescript
import Sample from '../models/Sample';

export class SampleRepository {
  async findSample() {
    return Sample.findOne().lean();
  }
}

export const sampleRepository = new SampleRepository();
```

The repository is responsible for data access.

Do not import a Mongoose model directly into a controller.

The intended dependency direction is:

```text
Controller → Service → Repository → Model
```

---

## 5. Create or Reuse the Model

If the endpoint needs persistent data, create:

```text
src/models/Sample.ts
```

Example:

```typescript
import { Schema, model } from 'mongoose';

const sampleSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
  },
  {
    timestamps: true,
  },
);

export default model('Sample', sampleSchema);
```

If an existing model already represents the required data, reuse it instead of introducing another model.

---

## 6. Add Validation

Create:

```text
src/validators/sampleValidator.ts
```

For a GET endpoint with query parameters, use a Zod schema.

Example:

```typescript
import { z } from 'zod';

export const sampleQuerySchema = z.object({
  search: z.string().trim().optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
```

Then validate through the existing middleware rather than parsing request input manually inside the controller.

---

## 7. Add Query Middleware When Required

For list endpoints requiring filtering, sorting, searching, and pagination, follow:

```text
src/middlewares/queryMiddleware.ts
```

The middleware supports:

```text
page
limit
sort
search
```

and whitelisted filter operators such as:

```text
eq
ne
gt
gte
lt
lte
in
nin
```

Example:

```typescript
router.get(
  '/',
  buildQueryOptions({
    filterableFields: {
      status: 'string',
    },
    sortableFields: ['createdAt', 'name'],
    searchableFields: ['name'],
  }),
  sampleController.list.bind(sampleController),
);
```

Do not allow arbitrary MongoDB operators from request input.

---

## 8. Register Dependencies

The application's DI container is:

```text
src/di/container.ts
```

The container registers configuration, models, services, and controllers using canonical tokens from:

```text
src/di/tokens.ts
```

If the new endpoint introduces a dependency that must be resolved through Awilix, register it there.

Example pattern:

```typescript
container.register({
  [TOKENS.sampleService]: asValue(sampleService),
  [TOKENS.sampleController]: asValue(sampleController),
});
```

Then import the appropriate token and implementation.

Do not create duplicate DI registrations or legacy aliases.

---

## 9. Mount the Route and Add OpenAPI Documentation

Update:

```text
src/routes/index.ts
```

Add:

```typescript
import sampleRoutes from './sampleRoutes';

router.use('/v1/sample', sampleRoutes);
```

This makes the endpoint reachable at:

```text
GET /api/v1/sample
```

The `/api` prefix comes from:

```typescript
// src/app.ts

app.use('/api', routes);
```

For OpenAPI documentation, follow the annotations already used in:

```text
src/routes/webhookRoutes.ts
```

Example:

```typescript
/**
 * @openapi
 * /v1/sample:
 *   get:
 *     tags: [Sample]
 *     summary: Retrieve sample data
 *     responses:
 *       200:
 *         description: Sample retrieved successfully
 */
router.get('/', sampleController.getSample.bind(sampleController));
```

The documented path is:

```text
/v1/sample
```

because Swagger is already configured beneath the application's API prefix.

---

## 10. Add Tests and Verify the Change

Add a focused test for the new behavior.

For route/controller behavior, follow existing integration tests such as:

```text
tests/integration/auth.flow.integration.test.ts
tests/integration/delivery.flow.integration.test.ts
```

Example:

```typescript
import request from 'supertest';
import { describe, expect, it } from '@jest/globals';
import app from '../../src/app';

describe('GET /api/v1/sample', () => {
  it('returns the sample response', async () => {
    const response = await request(app)
      .get('/api/v1/sample')
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.error).toBeNull();
  });
});
```

Run the specific test:

```bash
pnpm test -- tests/integration/sample.test.ts
```

Run the complete suite:

```bash
pnpm test
```

Check coverage:

```bash
pnpm test:coverage
```

Run lint:

```bash
pnpm lint
```

Run the TypeScript build:

```bash
pnpm build
```

For service-layer changes, also consider:

```bash
pnpm test:mutation
```

---

# Common Pitfalls

## 1. Forgetting the Route Mount

Creating:

```text
src/routes/sampleRoutes.ts
```

does not expose the endpoint.

You must add:

```typescript
router.use('/v1/sample', sampleRoutes);
```

to:

```text
src/routes/index.ts
```

---

## 2. Missing the API Version Prefix

Incorrect:

```typescript
router.use('/sample', sampleRoutes);
```

Correct:

```typescript
router.use('/v1/sample', sampleRoutes);
```

The final public URL is:

```text
/api/v1/sample
```

---

## 3. Bypassing the Response Envelope

Do not introduce:

```typescript
res.json({ result });
```

Use:

```typescript
sendSuccess(res, result, 'Sample retrieved successfully');
```

This preserves the project's response contract.

---

## 4. Using `any`

Avoid:

```typescript
const data: any = {};
```

Prefer an explicit type:

```typescript
interface SampleResponse {
  id: string;
  name: string;
}
```

or infer the type from the service/repository layer where appropriate.

---

## 5. Putting Business Logic in Routes

Avoid:

```typescript
router.get('/', async (_req, res) => {
  const records = await Sample.find();
  // business rules here
});
```

Prefer:

```text
route
  → controller
  → service
  → repository
  → model
```

---

## 6. Registering a Route Without Tests

Every new endpoint should have tests covering:

* successful response;
* invalid input;
* authentication/authorization where applicable;
* missing resources;
* service/repository failure paths where relevant.

---

## Final Verification

Before submitting the endpoint:

```bash
pnpm lint
pnpm build
pnpm test -- <specific-test>
pnpm test
pnpm test:coverage
```

Confirm the endpoint is reachable:

```bash
curl http://localhost:3000/api/v1/sample
```

Confirm that:

```text
src/routes/index.ts
```

contains the route mount and that the endpoint is represented in the OpenAPI documentation.

The implementation should follow the existing project architecture rather than introducing a parallel routing, validation, response, repository, or dependency-injection pattern.
