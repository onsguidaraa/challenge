import { z } from 'zod';
import { ACADEMIC_LEVELS, PREFERRED_FORMATS, TIMES_OF_DAY } from './profile.model.js';
import { normalizeTimeZone } from '../../utils/timezone.js';

const tag = z.string().trim().min(1, 'Must not be empty').max(100);

/** Trimmed, de-duplicated list of short strings. */
const tagList = z
  .array(tag)
  .max(20, 'At most 20 items')
  .transform((items) => [...new Set(items)]);

export const academicLevel = z.enum(ACADEMIC_LEVELS);
export const interests = tagList;
export const goals = tagList;
export const difficulties = tagList;
export const preferredFormats = z
  .array(z.enum(PREFERRED_FORMATS))
  .max(PREFERRED_FORMATS.length)
  .transform((items) => [...new Set(items)]);

/** IANA timezone such as "Europe/Paris". Stored in its canonical spelling; null clears it. */
export const timezone = z
  .string()
  .trim()
  .refine((value) => normalizeTimeZone(value) !== null, 'Must be a valid IANA timezone')
  .transform((value) => normalizeTimeZone(value))
  .nullable();

export const studyHabitsFields = {
  bestTimeOfDay: z.enum(TIMES_OF_DAY),
  preferredSessionMinutes: z.number().int().min(5).max(480),
  sessionsPerWeek: z.number().int().min(1).max(35),
};

/**
 * PATCH /profile: only user-editable fields. Unknown keys (e.g. learnedStats)
 * are stripped by Zod and therefore can never reach the database.
 */
export const updateProfileSchema = z
  .object({
    academicLevel,
    interests,
    goals,
    difficulties,
    preferredFormats,
    timezone,
    studyHabits: z.object(studyHabitsFields).partial(),
  })
  .partial()
  .refine(
    (body) =>
      Object.keys(body).length > 0 &&
      (body.studyHabits === undefined || Object.keys(body.studyHabits).length > 0),
    'Provide at least one editable field',
  );
