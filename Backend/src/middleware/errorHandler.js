import mongoose from 'mongoose';
import { ZodError } from 'zod';
import jwt from 'jsonwebtoken';
import { ApiError } from '../utils/ApiError.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const { TokenExpiredError, JsonWebTokenError, NotBeforeError } = jwt;

/** Maps any thrown value to an ApiError. Unknown errors become a generic 500. */
const normalizeError = (err) => {
  if (err instanceof ApiError) return err;

  if (err instanceof ZodError) {
    const details = err.issues.map((issue) => ({
      field: issue.path.join('.'),
      message: issue.message,
    }));
    return new ApiError(400, 'Validation failed', { code: 'VALIDATION_ERROR', details });
  }

  if (err instanceof mongoose.Error.ValidationError) {
    const details = Object.values(err.errors).map((e) => ({ field: e.path, message: e.message }));
    return new ApiError(400, 'Validation failed', { code: 'VALIDATION_ERROR', details });
  }

  if (err instanceof mongoose.Error.CastError) {
    return new ApiError(400, `Invalid value for "${err.path}"`, {
      code: 'INVALID_ID',
      details: [{ field: err.path, message: 'Invalid format' }],
    });
  }

  // MongoDB duplicate key
  if (err?.code === 11000) {
    const fields = Object.keys(err.keyPattern || err.keyValue || {});
    const label = fields.length ? fields.join(', ') : 'value';
    return new ApiError(409, `${label} already exists`, {
      code: 'DUPLICATE_KEY',
      details: fields.map((field) => ({ field, message: 'Already in use' })),
    });
  }

  if (err instanceof TokenExpiredError) {
    return new ApiError(401, 'Token has expired', { code: 'TOKEN_EXPIRED' });
  }
  if (err instanceof JsonWebTokenError || err instanceof NotBeforeError) {
    return new ApiError(401, 'Invalid token', { code: 'INVALID_TOKEN' });
  }

  // body-parser errors
  if (err?.type === 'entity.parse.failed') {
    return new ApiError(400, 'Malformed JSON body', { code: 'INVALID_JSON' });
  }
  if (err?.type === 'entity.too.large') {
    return new ApiError(413, 'Request body too large', { code: 'PAYLOAD_TOO_LARGE' });
  }

  return new ApiError(500, 'Internal server error', { code: 'INTERNAL_ERROR' });
};

export const errorHandler = (err, req, res, _next) => {
  const apiError = normalizeError(err);

  if (apiError.statusCode >= 500) {
    logger.error(`${req.method} ${req.originalUrl}`, err);
  }

  const message =
    apiError.statusCode >= 500 && env.isProduction ? 'Internal server error' : apiError.message;

  res.status(apiError.statusCode).json({
    success: false,
    error: {
      code: apiError.code,
      message,
      details: apiError.details ?? null,
    },
  });
};
