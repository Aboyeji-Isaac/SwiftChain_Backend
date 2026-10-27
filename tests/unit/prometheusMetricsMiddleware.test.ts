import { EventEmitter } from 'events';
import type { Request, Response } from 'express';
import prometheusMetricsService from '../../src/services/prometheusMetricsService';
import prometheusMetricsMiddleware from '../../src/middleware/prometheusMetricsMiddleware';

jest.mock('../../src/services/prometheusMetricsService', () => ({
  __esModule: true,
  default: {
    recordRequest: jest.fn(),
  },
}));

describe('prometheusMetricsMiddleware', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('records route templates instead of concrete request URLs', () => {
    const req = {
      path: '/api/v1/drivers/driver-123',
      method: 'GET',
      baseUrl: '/api/v1/drivers',
      route: { path: '/:driverId' },
    } as unknown as Request;
    const res = new EventEmitter() as unknown as Response;
    Object.defineProperty(res, 'statusCode', { value: 200, writable: true });
    const next = jest.fn();

    prometheusMetricsMiddleware(req, res, next);
    res.emit('finish');

    expect(next).toHaveBeenCalledTimes(1);
    expect(prometheusMetricsService.recordRequest).toHaveBeenCalledWith(
      'GET',
      '/api/v1/drivers/:driverId',
      200,
      expect.any(Number),
    );
  });

  it('does not record metrics scrapes as ordinary HTTP traffic', () => {
    const req = {
      path: '/metrics',
      method: 'GET',
      baseUrl: '',
      route: { path: '/' },
    } as unknown as Request;
    const res = new EventEmitter() as unknown as Response;
    Object.defineProperty(res, 'statusCode', { value: 200, writable: true });
    const next = jest.fn();

    prometheusMetricsMiddleware(req, res, next);
    res.emit('finish');

    expect(next).toHaveBeenCalledTimes(1);
    expect(prometheusMetricsService.recordRequest).not.toHaveBeenCalled();
  });
});
