import * as authService from './auth.service.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { sendSuccess } from '../../utils/response.js';

const authPayload = ({ user, accessToken, refreshToken }) => ({ user, accessToken, refreshToken });

export const register = asyncHandler(async (req, res) => {
  const result = await authService.register(req.body);
  sendSuccess(res, authPayload(result), 'Registration successful', 201);
});

export const login = asyncHandler(async (req, res) => {
  const result = await authService.login(req.body);
  sendSuccess(res, authPayload(result), 'Login successful');
});

export const refresh = asyncHandler(async (req, res) => {
  const result = await authService.refresh(req.body.refreshToken);
  sendSuccess(res, authPayload(result), 'Token refreshed');
});

export const logout = asyncHandler(async (req, res) => {
  await authService.logout(req.body.refreshToken);
  sendSuccess(res, null, 'Logged out');
});

export const me = asyncHandler(async (req, res) => {
  sendSuccess(res, { user: req.user }, 'Current user');
});
