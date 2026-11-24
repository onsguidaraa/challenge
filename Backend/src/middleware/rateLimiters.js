import rateLimit from 'express-rate-limit';
import { ApiError } from '../utils/ApiError.js';
import { env } from '../config/env.js';

const build = ({ windowMs, limit, message }) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => env.isTest,
    handler: (_req, _res, next) => next(new ApiError(429, message, { code: 'TOO_MANY_REQUESTS' })),
  });

/** Applied to every request. */
export const globalLimiter = build({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  message: 'Too many requests, please try again later',
});

/** Stricter limiter for /auth routes (brute-force protection). */
export const authLimiter = build({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  message: 'Too many authentication attempts, please try again later',
});
