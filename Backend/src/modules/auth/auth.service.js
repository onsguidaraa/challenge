import bcrypt from 'bcrypt';
import { User } from './auth.model.js';
import { ApiError } from '../../utils/ApiError.js';
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  hashToken,
  refreshTokenExpiryDate,
} from '../../services/token.service.js';

const BCRYPT_ROUNDS = 12;
const MAX_REFRESH_TOKENS_PER_USER = 10;

// Used to keep login timing similar when the email does not exist.
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', BCRYPT_ROUNDS);

const invalidCredentials = () =>
  ApiError.unauthorized('Invalid email or password', { code: 'INVALID_CREDENTIALS' });

const invalidRefreshToken = () =>
  ApiError.unauthorized('Invalid or expired refresh token', { code: 'INVALID_REFRESH_TOKEN' });

/** Creates an access + refresh token pair and stores only the hash of the refresh token. */
const issueTokens = async (user) => {
  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user);

  // Drop expired entries, then append the new one (keeping only the most recent N).
  await User.updateOne(
    { _id: user._id },
    { $pull: { refreshTokens: { expiresAt: { $lte: new Date() } } } },
  );
  await User.updateOne(
    { _id: user._id },
    {
      $push: {
        refreshTokens: {
          $each: [{ tokenHash: hashToken(refreshToken), expiresAt: refreshTokenExpiryDate() }],
          $slice: -MAX_REFRESH_TOKENS_PER_USER,
        },
      },
    },
  );

  return { accessToken, refreshToken };
};

export const register = async ({ name, email, password }) => {
  const existing = await User.exists({ email });
  if (existing) {
    throw ApiError.conflict('Email already registered', { code: 'EMAIL_TAKEN' });
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  // A concurrent duplicate is caught by the unique index and mapped to 409 by the error handler.
  const user = await User.create({ name, email, passwordHash });
  const tokens = await issueTokens(user);
  return { user, ...tokens };
};

export const login = async ({ email, password }) => {
  const user = await User.findOne({ email }).select('+passwordHash');
  const valid = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !valid) throw invalidCredentials();

  const tokens = await issueTokens(user);
  return { user, ...tokens };
};

/**
 * Rotates a refresh token: the presented token is atomically removed and a new pair is issued.
 * If a token that is validly signed but no longer stored is presented (reuse of an already
 * rotated/revoked token), all sessions of that user are revoked.
 */
export const refresh = async (presentedToken) => {
  let payload;
  try {
    payload = verifyRefreshToken(presentedToken);
  } catch {
    throw invalidRefreshToken();
  }

  const tokenHash = hashToken(presentedToken);

  const user = await User.findOneAndUpdate(
    {
      _id: payload.sub,
      refreshTokens: { $elemMatch: { tokenHash, expiresAt: { $gt: new Date() } } },
    },
    { $pull: { refreshTokens: { tokenHash } } },
  );

  if (!user) {
    await User.updateOne({ _id: payload.sub }, { $set: { refreshTokens: [] } });
    throw invalidRefreshToken();
  }

  const tokens = await issueTokens(user);
  return { user, ...tokens };
};

/** Revokes a refresh token. Idempotent: unknown or already revoked tokens are ignored. */
export const deleteAccount = async (userId) => {
  const result = await User.deleteOne({ _id: userId });
  if (!result.deletedCount) throw ApiError.notFound('User not found');
};

export const logout = async (presentedToken) => {
  const tokenHash = hashToken(presentedToken);
  await User.updateOne(
    { 'refreshTokens.tokenHash': tokenHash },
    { $pull: { refreshTokens: { tokenHash } } },
  );
};
