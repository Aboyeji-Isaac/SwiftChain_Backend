import express from 'express';
import request from 'supertest';
import adminRoutes from '../src/routes/adminRoutes';
import errorHandler from '../src/middleware/errorHandler';

describe('admin DLQ routes', () => {
  const app = express();
  app.use('/v1/admin', adminRoutes);
  app.use(errorHandler);

  it('mounts the DLQ list route and rejects unauthenticated requests', async () => {
    const response = await request(app).get('/v1/admin/dlq');

    expect(response.status).toBe(401);
  });

  it('mounts the DLQ retry route and rejects unauthenticated requests', async () => {
    const response = await request(app).post('/v1/admin/dlq/example-id/retry');

    expect(response.status).toBe(401);
  });
});
