import * as onboardingService from './onboarding.service.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { sendSuccess } from '../../utils/response.js';

export const submit = asyncHandler(async (req, res) => {
  const result = await onboardingService.submitOnboarding(req.user, req.body);
  sendSuccess(res, result, 'Onboarding completed');
});

export const status = asyncHandler(async (req, res) => {
  const result = await onboardingService.getStatus(req.user);
  sendSuccess(res, result, 'Onboarding status');
});
