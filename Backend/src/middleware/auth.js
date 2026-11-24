import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { verifyAccessToken } from '../services/token.service.js';
import { User } from '../modules/auth/auth.model.js';

/** Verifies the Bearer access token and attaches the user document to req.user. */
export const auth = asyncHandler(async (req, _res, next) => {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    throw ApiError.unauthorized('Authentication required', { code: 'AUTH_REQUIRED' });
  }

  // JWT errors (invalid / expired) are mapped to 401 by the error handler.
  const payload = verifyAccessToken(token);

  const user = await User.findById(payload.sub);
  if (!user) {
    throw ApiError.unauthorized('User no longer exists', { code: 'INVALID_TOKEN' });
  }

  req.user = user;
  next();
});

/** Restricts a route to the given roles. Must be used after `auth`. */
export const requireRole =
  (...roles) =>
  (req, _res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(ApiError.forbidden('Insufficient permissions'));
    }
    next();
  };
