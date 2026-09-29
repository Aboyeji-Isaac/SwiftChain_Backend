import request from 'supertest';
import express, { Express, NextFunction, Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import {
  buildPaginationMeta,
  buildQueryOptions,
  resolveQueryOptions,
} from '../src/middlewares/queryMiddleware';
import { QueryFeatureConfig } from '../src/types/query';
import ApiError from '../src/utils/ApiError';

const config: QueryFeatureConfig = {
  sortableFields: ['createdAt', 'amount', 'status'],
  filterableFields: {
    status: 'string',
    amount: 'number',
    active: 'boolean',
    createdAt: 'date',
    owner: 'objectId',
  },
  searchableFields: ['reference', 'notes'],
  defaultSort: { createdAt: -1 },
  defaultLimit: 20,
  maxLimit: 50,
};

/** Exposes the parsed options so assertions can inspect them directly. */
const buildApp = (): Express => {
  const app = express();

  app.get('/items', buildQueryOptions(config), (req: Request, res: Response) => {
    res.status(200).json(resolveQueryOptions(req));
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    const statusCode = err instanceof ApiError ? err.statusCode : 500;
    res.status(statusCode).json({ status: 'error', message: err.message });
  });

  return app;
};

describe('Query middleware', () => {
  const app = buildApp();

  describe('pagination', () => {
    it('applies documented defaults when no parameters are supplied', async () => {
      const { body } = await request(app).get('/items').expect(200);

      expect(body).toMatchObject({ page: 1, limit: 20, skip: 0 });
      expect(body.sort).toEqual({ createdAt: -1 });
    });

    it('derives skip from page and limit', async () => {
      const { body } = await request(app).get('/items?page=4&limit=15').expect(200);

      expect(body).toMatchObject({ page: 4, limit: 15, skip: 45 });
    });

    it('clamps an oversized limit to the route maximum', async () => {
      const { body } = await request(app).get('/items?limit=5000').expect(200);

      expect(body.limit).toBe(50);
    });

    it.each([
      ['page=0', 'page'],
      ['page=-2', 'page'],
      ['page=abc', 'page'],
      ['limit=0', 'limit'],
      ['limit=1.5', 'limit'],
    ])('rejects a malformed pagination value (%s)', async (query, field) => {
      const { body } = await request(app).get(`/items?${query}`).expect(StatusCodes.BAD_REQUEST);

      expect(body.message).toContain(field);
    });
  });

  describe('sorting', () => {
    it('parses ascending and descending fields', async () => {
      const { body } = await request(app).get('/items?sort=-amount,status').expect(200);

      expect(body.sort).toEqual({ amount: -1, status: 1 });
    });

    it('rejects a field outside the allow-list', async () => {
      const { body } = await request(app)
        .get('/items?sort=password')
        .expect(StatusCodes.BAD_REQUEST);

      expect(body.message).toMatch(/cannot sort by `password`/i);
    });
  });

  describe('filtering', () => {
    it('builds an equality filter and coerces the declared type', async () => {
      const { body } = await request(app)
        .get('/items?status=pending&amount=250&active=true')
        .expect(200);

      expect(body.filter).toEqual({ status: 'pending', amount: 250, active: true });
    });

    it('supports range operators in bracket notation', async () => {
      const { body } = await request(app).get('/items?amount[gte]=100&amount[lt]=500').expect(200);

      expect(body.filter.amount).toEqual({ $gte: 100, $lt: 500 });
    });

    it('splits `in` operators into a coerced array', async () => {
      const { body } = await request(app).get('/items?status[in]=pending,accepted').expect(200);

      expect(body.filter.status).toEqual({ $in: ['pending', 'accepted'] });
    });

    it('ignores query parameters that are not filterable', async () => {
      const { body } = await request(app).get('/items?password=secret&role=admin').expect(200);

      expect(body.filter).toEqual({});
    });

    it('rejects an unsupported operator', async () => {
      const { body } = await request(app)
        .get('/items?amount[where]=1')
        .expect(StatusCodes.BAD_REQUEST);

      expect(body.message).toMatch(/unsupported operator/i);
    });

    it.each([
      ['amount=not-a-number', /must be a valid number/i],
      ['active=maybe', /must be either "true" or "false"/i],
      ['createdAt=not-a-date', /must be a valid ISO 8601 date/i],
      ['owner=123', /must be a valid identifier/i],
    ])('rejects a value that fails coercion (%s)', async (query, expected) => {
      const { body } = await request(app).get(`/items?${query}`).expect(StatusCodes.BAD_REQUEST);

      expect(body.message).toMatch(expected);
    });
  });

  describe('search', () => {
    it('builds a case-insensitive $or clause across searchable fields', async () => {
      const { body } = await request(app).get('/items?search=lagos').expect(200);

      expect(body.filter.$and).toHaveLength(2);
      expect(body.filter.$and[1].$or).toHaveLength(2);
    });

    it('escapes regular-expression metacharacters in the search term', () => {
      // Asserted against the middleware directly because a RegExp does not
      // survive JSON serialization over HTTP.
      const req = { query: { search: 'a.*b' } } as unknown as Request;
      const next = jest.fn();

      buildQueryOptions(config)(req, {} as Response, next);

      expect(next).toHaveBeenCalledWith();

      const clauses = (
        req.queryOptions?.filter as { $and: Array<{ $or: Array<Record<string, RegExp>> }> }
      ).$and[1].$or;

      // An unescaped `.*` would match every document rather than the literal.
      expect(clauses[0].reference.source).toBe('a\\.\\*b');
      expect(clauses[0].reference.flags).toBe('i');
      expect(clauses[0].reference.test('a.*b')).toBe(true);
      expect(clauses[0].reference.test('axxb')).toBe(false);
    });
  });
});

describe('buildPaginationMeta', () => {
  it('computes page counts and navigation flags for a middle page', () => {
    expect(buildPaginationMeta(137, 2, 20)).toEqual({
      totalItems: 137,
      totalPages: 7,
      currentPage: 2,
      limit: 20,
      hasNextPage: true,
      hasPreviousPage: true,
      nextPage: 3,
      previousPage: 1,
    });
  });

  it('reports no next page on the final page', () => {
    const meta = buildPaginationMeta(40, 2, 20);

    expect(meta).toMatchObject({ totalPages: 2, hasNextPage: false, nextPage: null });
  });

  it('handles an empty result set without reporting phantom pages', () => {
    expect(buildPaginationMeta(0, 1, 20)).toMatchObject({
      totalItems: 0,
      totalPages: 0,
      hasNextPage: false,
      hasPreviousPage: false,
      nextPage: null,
      previousPage: null,
    });
  });
});
