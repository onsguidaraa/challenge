import * as profileService from './profile.service.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { sendSuccess } from '../../utils/response.js';

export const getProfile = asyncHandler(async (req, res) => {
  const profile = await profileService.getProfile(req.user._id);
  sendSuccess(res, { profile }, 'Learning profile');
});

export const updateProfile = asyncHandler(async (req, res) => {
  const profile = await profileService.updateProfile(req.user._id, req.body);
  sendSuccess(res, { profile }, 'Learning profile updated');
});

export const recompute = asyncHandler(async (req, res) => {
  const profile = await profileService.forceRecomputeLearnedStats(req.user._id);
  sendSuccess(res, { profile }, 'Learning DNA recomputed');
});

export const getSummary = asyncHandler(async (req, res) => {
  const result = await profileService.getProfileSummary(req.user._id);
  sendSuccess(res, result, 'Learning profile summary');
});
