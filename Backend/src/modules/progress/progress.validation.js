import { z } from 'zod';
import { idParam, objectId } from '../../utils/objectId.js';
import { paginationQuery } from '../../utils/pagination.js';
import { ACTIVITY_TYPES } from '../activity-log/activity-log.model.js';

/**
 * ISO 8601 date ("2026-05-01") or date-time. A date-only `to` means the end of that UTC
 * day, so `to=2026-05-01` includes everything that happened on May 1st.
 */
const isoDate = ({ endOfDay = false } = {}) =>
  z
    .union([z.iso.datetime({ offset: true }), z.iso.date()], { error: 'Must be an ISO date' })
    .transform((value) => {
      const date = new Date(value);
      if (endOfDay && value.length === 10) date.setUTCHours(23, 59, 59, 999);
      return date;
    });

const dateRange = {
  from: isoDate().optional(),
  to: isoDate({ endOfDay: true }).optional(),
};

const fromBeforeTo = [
  (q) => !q.from || !q.to || q.from <= q.to,
  { message: 'from must not be after to', path: ['from'] },
];

export const subjectIdParamSchema = idParam('id');

export const subjectsQuerySchema = z.object({ ...paginationQuery });

export const quizHistoryQuerySchema = z
  .object({ topic: objectId.optional(), ...dateRange, ...paginationQuery })
  .refine(...fromBeforeTo);

/** `type` accepts one activity type or a comma-separated list: ?type=quiz_submitted,lesson_completed */
const activityTypes = z
  .string()
  .transform((value) => [
    ...new Set(
      value
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    ),
  ])
  .pipe(z.array(z.enum(ACTIVITY_TYPES)).min(1));

export const activityQuerySchema = z
  .object({ type: activityTypes.optional(), ...dateRange, ...paginationQuery })
  .refine(...fromBeforeTo);

export const MAX_HEATMAP_DAYS = 365;

export const heatmapQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(MAX_HEATMAP_DAYS).default(90),
});
