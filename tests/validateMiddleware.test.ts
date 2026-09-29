/**
 * Unit tests for the canonical Zod validation middleware.
 *
 * Covers every validation path: body / query / params, schema-less pass
 * through, value coercion written back to the request, and the standardised
 * error envelope returned when one or more locations fail.
 */

import express, { Express, Request, Response } from 'express';
import request from 'supertest';
import { z } from 'zod';
import { StatusCodes } from 'http-status-codes';
import validate from '../src/middleware/validate';

const bodySchema = z.object({
  name: z.string().min(3),
  amount: z.coerce.number().positive(),
});

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  status: z.enum(['active', 'archived']).optional(),
});

const paramsSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{24}$/, 'id must be a 24-char hex string'),
});

/** Echoes the validated request parts so assertions can inspect write-back. */
const buildApp = (): Express => {
  const app = express();
  app.use(express.json());

  const echo = (req: Request, res: Response): void => {
    res.status(StatusCodes.OK).json({
      body: req.body,
      query: req.query,
      params: req.params,
    });
  };

  app.post('/body-only', validate({ body: bodySchema }), echo);
  app.get('/query-only', validate({ query: querySchema }), echo);
  app.get('/params-only/:id', validate({ params: paramsSchema }), echo);
  app.patch(
    '/all/:id',
    validate({ body: bodySchema, query: querySchema, params: paramsSchema }),
    echo,
  );
  app.get('/no-schemas', validate({}), (req: Request, res: Response) => {
    res.status(StatusCodes.OK).json({ success: true });
  });

  return app;
};

describe('validate middleware', () => {
  const app = buildApp();

  describe('body validation', () => {
    it('passes valid payloads and writes the parsed value back to req.body', async () => {
      const res = await request(app).post('/body-only').send({ name: 'Ada', amount: '25' });

      expect(res.status).toBe(StatusCodes.OK);
      expect(res.body.body).toEqual({ name: 'Ada', amount: 25 });
    });

    it('returns the standardised error envelope for an invalid body', async () => {
      const res = await request(app).post('/body-only').send({ name: 'a', amount: -1 });

      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
      expect(res.body).toMatchObject({
        success: false,
        data: null,
        error: 'Validation failed',
        message: 'Validation failed',
      });
      expect(res.body.errors).toEqual(
        expect.arrayContaining([
          { location: 'body', field: 'name', message: expect.any(String) },
          { location: 'body', field: 'amount', message: expect.any(String) },
        ]),
      );
    });
  });

  describe('query validation', () => {
    it('coerces query values and applies schema defaults', async () => {
      const res = await request(app).get('/query-only?page=3&status=archived');

      expect(res.status).toBe(StatusCodes.OK);
      expect(res.body.query).toEqual({ page: 3, status: 'archived' });
    });

    it('reports failures with location "query"', async () => {
      const res = await request(app).get('/query-only?page=0&status=unknown');

      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
      expect(res.body.errors).toEqual(
        expect.arrayContaining([
          { location: 'query', field: 'page', message: expect.any(String) },
          { location: 'query', field: 'status', message: expect.any(String) },
        ]),
      );
    });
  });

  describe('params validation', () => {
    it('passes valid route params through untouched', async () => {
      const id = '507f1f77bcf86cd799439011';
      const res = await request(app).get(`/params-only/${id}`);

      expect(res.status).toBe(StatusCodes.OK);
      expect(res.body.params).toEqual({ id });
    });

    it('reports failures with location "params"', async () => {
      const res = await request(app).get('/params-only/not-an-id');

      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
      expect(res.body.errors).toEqual([
        {
          location: 'params',
          field: 'id',
          message: 'id must be a 24-char hex string',
        },
      ]);
    });
  });

  describe('combined schemas', () => {
    it('accepts a request where every location is valid', async () => {
      const id = '507f1f77bcf86cd799439011';
      const res = await request(app).patch(`/all/${id}?page=2`).send({ name: 'Grace', amount: 10 });

      expect(res.status).toBe(StatusCodes.OK);
      expect(res.body).toEqual({
        body: { name: 'Grace', amount: 10 },
        query: { page: 2 },
        params: { id },
      });
    });

    it('aggregates errors from every failing location', async () => {
      const res = await request(app).patch('/all/bad?page=-1').send({ name: 'x', amount: 0 });

      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
      expect(res.body.message).toBe('Validation failed');
      expect(res.body.errors.map((error: { location: string }) => error.location).sort()).toEqual([
        'body',
        'body',
        'params',
        'query',
      ]);
    });
  });

  it('calls next() when no schema is provided', async () => {
    const res = await request(app).get('/no-schemas');

    expect(res.status).toBe(StatusCodes.OK);
    expect(res.body).toEqual({ success: true });
  });
});
