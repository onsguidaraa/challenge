import { z } from 'zod';
import {
  academicLevel,
  interests,
  goals,
  difficulties,
  preferredFormats,
  studyHabitsFields,
} from '../profile/profile.validation.js';

export const onboardingSchema = z.object({
  academicLevel,
  interests: interests.refine((v) => v.length > 0, 'Add at least one interest'),
  goals: goals.refine((v) => v.length > 0, 'Add at least one goal'),
  // A learner may genuinely have no known difficulties yet.
  difficulties,
  preferredFormats: preferredFormats.refine((v) => v.length > 0, 'Pick at least one format'),
  studyHabits: z.object(studyHabitsFields),
  retake: z.boolean().optional().default(false),
});
