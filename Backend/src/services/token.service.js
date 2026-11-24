import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { durationToMs } from '../utils/duration.js';

export const signAccessToken = (user) =>
  jwt.sign({ role: user.role }, env.JWT_ACCESS_SECRET, {
    subject: String(user._id),
    expiresIn: env.ACCESS_TOKEN_TTL,
  });

/** Refresh tokens carry a random jti so two tokens issued in the same second never collide. */
export const signRefreshToken = (user) =>
  jwt.sign({}, env.JWT_REFRESH_SECRET, {
    subject: String(user._id),
    expiresIn: env.REFRESH_TOKEN_TTL,
    jwtid: crypto.randomUUID(),
  });

export const verifyAccessToken = (token) => jwt.verify(token, env.JWT_ACCESS_SECRET);

export const verifyRefreshToken = (token) => jwt.verify(token, env.JWT_REFRESH_SECRET);

/** Refresh tokens are stored hashed (SHA-256), never in plain text. */
export const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

export const refreshTokenExpiryDate = () =>
  new Date(Date.now() + durationToMs(env.REFRESH_TOKEN_TTL));
