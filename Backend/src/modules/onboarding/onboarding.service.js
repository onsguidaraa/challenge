import { User } from '../auth/auth.model.js';
import { ApiError } from '../../utils/ApiError.js';
import { findProfile, upsertProfileAnswers } from '../profile/profile.service.js';
import { logActivity } from '../../services/activity.service.js';

const ANSWER_FIELDS = [
  'academicLevel',
  'interests',
  'goals',
  'difficulties',
  'preferredFormats',
  'studyHabits',
];

const pickAnswers = (profile) => {
  if (!profile) return null;
  const json = profile.toJSON();
  return Object.fromEntries(ANSWER_FIELDS.map((f) => [f, json[f]]));
};

export const getStatus = async (user) => {
  const profile = await findProfile(user._id);
  return { completed: Boolean(user.onboardingCompleted), answers: pickAnswers(profile) };
};

export const submitOnboarding = async (user, { retake, ...answers }) => {
  if (user.onboardingCompleted && !retake) {
    throw ApiError.conflict('Onboarding already completed. Send retake: true to redo it.', {
      code: 'ONBOARDING_ALREADY_COMPLETED',
    });
  }

  const profile = await upsertProfileAnswers(user._id, answers);

  // Updated atomically on the user document; the auth middleware loads a fresh user per request.
  await User.updateOne({ _id: user._id }, { $set: { onboardingCompleted: true } });

  await logActivity({
    user: user._id,
    type: 'onboarding_completed',
    refId: profile._id,
    refModel: 'Profile',
    metadata: { retake: Boolean(user.onboardingCompleted) },
  });

  return { completed: true, profile };
};
