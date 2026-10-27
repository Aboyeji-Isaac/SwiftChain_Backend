import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';

jest.mock('../src/middleware/authenticate', () => ({
  __esModule: true,
  default: (req: Request, _res: Response, next: NextFunction): void => {
    const role = req.get('x-test-role') === 'admin' ? 'admin' : 'user';
    (req as unknown as { user?: { role: string } }).user = { role };
    next();
  },
}));

jest.mock('../src/services/adminDriverSearchService', () => ({
  adminDriverSearchService: {
    search: jest.fn().mockResolvedValue({
      drivers: [],
      meta: {
        totalItems: 0,
        totalPages: 0,
        currentPage: 1,
        limit: 20,
        hasNextPage: false,
        hasPreviousPage: false,
        nextPage: null,
        previousPage: null,
      },
    }),
  },
}));

import adminRoutes from '../src/routes/adminRoutes';

describe('GET /api/v1/admin/drivers authorization', () => {
  const app = express();
  app.use('/api/v1/admin', adminRoutes);
  app.use(
    (error: Error & { statusCode?: number }, _req: Request, res: Response, _next: NextFunction) => {
      res.status(error.statusCode ?? 500).json({ message: error.message });
    },
  );

  it('denies a non-admin before searching drivers', async () => {
    const response = await request(app).get('/api/v1/admin/drivers').set('x-test-role', 'user');

    expect(response.status).toBe(403);
    expect(response.body.message).toMatch(/permission/i);
  });

  it('allows an admin through to the search controller', async () => {
    const response = await request(app).get('/api/v1/admin/drivers').set('x-test-role', 'admin');

    expect(response.status).toBe(200);
    expect(response.body.data.drivers).toEqual([]);
  });
});
