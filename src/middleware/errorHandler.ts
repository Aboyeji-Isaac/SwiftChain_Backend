import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Error as MongooseError } from 'mongoose';
import logger from '../config/logger';
import AppError from '../utils/AppError';
import { sendError } from '../utils/responseWrapper';
import env from '../config/env';

const handleCastErrorDB = (err: MongooseError.CastError): AppError => {
  const message = `Invalid ${err.path}: ${err.value}.`;
  return new AppError(message, 400);
};

const handleDuplicateFieldsDB = (err: { errmsg?: string; code?: number }): AppError => {
  const value = err.errmsg?.match(/(["'])(\\?.)*?\1/)?.[0] || '';
  const message = `Duplicate field value: ${value}. Please use another value!`;
  return new AppError(message, 400);
};

const handleValidationErrorDB = (err: MongooseError.ValidationError): AppError => {
  const errors = Object.values(err.errors).map((el) => el.message);
  const message = `Invalid input data. ${errors.join('. ')}`;
  return new AppError(message, 400);
};

const sendErrorDev = (err: AppError, _req: Request, res: Response): void => {
  // In development we include the stack in the `error` field so it is still
  // accessible, but the top-level envelope always matches the standard shape.
  sendError(res, err.stack ?? err.message, err.statusCode, err.message);
};

const sendErrorProd = (err: AppError, _req: Request, res: Response): void => {
  if (err.isOperational) {
    sendError(res, err.message, err.statusCode, err.message);
  } else {
    logger.error('ERROR 💥', err);
    sendError(res, 'Something went very wrong!', 500, 'Something went very wrong!');
  }
};

const errorHandler = (
  err: Error & {
    statusCode?: number;
    name?: string;
    code?: number;
    errmsg?: string;
    errors?: Record<string, MongooseError.ValidatorError>;
    issues?: z.ZodIssue[];
  },
  req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  let error: AppError;

  if (err.name === 'CastError') {
    error = handleCastErrorDB(err as MongooseError.CastError);
  } else if (err.code === 11000) {
    error = handleDuplicateFieldsDB(err);
  } else if (err.name === 'ValidationError') {
    error = handleValidationErrorDB(err as MongooseError.ValidationError);
  } else if (err instanceof z.ZodError) {
    error = new AppError('Validation failed', 400);
  } else if (err instanceof AppError) {
    error = err;
  } else if (err.name === 'MulterError') {
    error = new AppError(`File upload error: ${err.message}`, 400);
  } else if (err.name === 'JsonWebTokenError') {
    error = new AppError('Invalid token', 401);
  } else if (err.name === 'TokenExpiredError') {
    error = new AppError('Token has expired', 401);
  } else {
    error = new AppError(err.message || 'Internal Server Error', err.statusCode || 500);
  }

  logger.error(
    `${error.statusCode} - ${error.message} - ${req.originalUrl} - ${req.method} - ${req.ip}`,
  );

  if (env.NODE_ENV === 'development' || env.NODE_ENV === 'test') {
    sendErrorDev(error, req, res);
  } else {
    sendErrorProd(error, req, res);
  }
};

export default errorHandler;
