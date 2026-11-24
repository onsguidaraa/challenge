import { z } from 'zod';
import { objectId, idParam } from '../../utils/objectId.js';
import { paginationQuery } from '../../utils/pagination.js';
import {
  PLAN_STATUSES,
  TASK_TYPES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  RECURRENCE_TYPES,
} from './planner.model.js';

const requiredText = (max, label) => z.string().trim().min(1, `${label} is required`).max(max);

const atLeastOneField = [
  (body) => Object.keys(body).length > 0,
  'Provide at least one field to update',
];

/**
 * ISO 8601 date ("2026-05-01") or date-time ("2026-05-01T10:00:00Z" / with offset),
 * parsed to a Date. With `endOfDay`, a date-only value means the end of that UTC day
 * (so `dueTo=2026-05-01` includes everything due on May 1st).
 */
const isoDate = ({ endOfDay = false } = {}) =>
  z
    .union([z.iso.datetime({ offset: true }), z.iso.date()], { error: 'Must be an ISO date' })
    .transform((value) => {
      const date = new Date(value);
      if (endOfDay && value.length === 10) date.setUTCHours(23, 59, 59, 999);
      return date;
    });

const uniqueIds = (max, label) =>
  z
    .array(objectId)
    .max(max, `At most ${max} ${label}`)
    .refine((ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length, {
      message: `${label} must be unique`,
    });

/** Optional body: Express 5 leaves req.body undefined when no body is sent. */
const optionalBody = (schema) => z.preprocess((value) => value ?? {}, schema);

/* ------------------------------- Params -------------------------------- */

export const idParamSchema = idParam('id');
export const planIdParamSchema = idParam('planId');

/* --------------------------------- Plan -------------------------------- */

const planFields = {
  title: requiredText(200, 'Title'),
  description: z.string().trim().max(2000),
  goal: z.string().trim().max(2000),
  targetDate: isoDate().nullable(),
  startDate: isoDate(),
  subjects: uniqueIds(50, 'Subjects'),
  status: z.enum(PLAN_STATUSES),
};

const startBeforeTarget = [
  (plan) => !plan.startDate || !plan.targetDate || plan.targetDate >= plan.startDate,
  { message: 'targetDate must not be before startDate', path: ['targetDate'] },
];

export const createPlanSchema = z
  .object({
    title: planFields.title,
    description: planFields.description.optional(),
    goal: planFields.goal.optional(),
    targetDate: planFields.targetDate.optional(),
    startDate: planFields.startDate.optional(),
    subjects: planFields.subjects.optional(),
    status: planFields.status.optional(),
  })
  .refine(...startBeforeTarget);

export const updatePlanSchema = z
  .object(planFields)
  .partial()
  .refine(...atLeastOneField)
  .refine(...startBeforeTarget);

export const listPlansQuerySchema = z.object({
  ...paginationQuery,
  status: planFields.status.optional(),
});

/* --------------------------------- Task -------------------------------- */

const recurrence = z
  .object({
    type: z.enum(RECURRENCE_TYPES),
    until: isoDate().nullable().optional(),
  })
  .refine((r) => r.type !== 'none' || !r.until, {
    message: 'until requires a daily or weekly recurrence',
    path: ['until'],
  });

const taskFields = {
  title: requiredText(200, 'Title'),
  notes: z.string().trim().max(5000),
  type: z.enum(TASK_TYPES),
  dueDate: isoDate().nullable(),
  estimatedMinutes: z.number().int().min(1).max(1440).nullable(),
  priority: z.enum(TASK_PRIORITIES),
  subject: objectId.nullable(),
  topic: objectId.nullable(),
  recurrence,
};

/** Status values that can be set directly. `done` goes through PATCH /tasks/:id/complete. */
const SETTABLE_STATUSES = TASK_STATUSES.filter((s) => s !== 'done');

export const createTaskSchema = z.object({
  title: taskFields.title,
  notes: taskFields.notes.optional(),
  type: taskFields.type.optional(),
  dueDate: taskFields.dueDate.optional(),
  estimatedMinutes: taskFields.estimatedMinutes.optional(),
  priority: taskFields.priority.optional(),
  subject: taskFields.subject.optional(),
  topic: taskFields.topic.optional(),
  recurrence: taskFields.recurrence.optional(),
  status: z.enum(['todo', 'in_progress']).optional(),
});

export const updateTaskSchema = z
  .object({
    ...taskFields,
    // A task can be moved into a plan or taken out of it (null).
    plan: objectId.nullable(),
    status: z.enum(SETTABLE_STATUSES),
  })
  .partial()
  .refine(...atLeastOneField);

export const listTasksQuerySchema = z
  .object({
    ...paginationQuery,
    status: z.enum(TASK_STATUSES).optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
    topic: objectId.optional(),
    dueFrom: isoDate().optional(),
    dueTo: isoDate({ endOfDay: true }).optional(),
  })
  .refine((q) => !q.dueFrom || !q.dueTo || q.dueFrom <= q.dueTo, {
    message: 'dueFrom must not be after dueTo',
    path: ['dueFrom'],
  });

export const UPCOMING_RANGES = ['day', 'week', 'month'];

export const upcomingQuerySchema = z.object({
  range: z.enum(UPCOMING_RANGES).default('week'),
  date: isoDate().optional(),
});

/* -------------------------------- Session ------------------------------ */

export const startSessionSchema = optionalBody(
  z.object({
    task: objectId.optional(),
    topic: objectId.optional(),
    plannedMinutes: z.number().int().min(1).max(720).optional(),
    notes: z.string().trim().max(5000).optional(),
  }),
);

export const stopSessionSchema = optionalBody(
  z.object({
    notes: z.string().trim().max(5000).optional(),
    focusRating: z.number().int().min(1).max(5).optional(),
  }),
);

export const listSessionsQuerySchema = z
  .object({
    ...paginationQuery,
    from: isoDate().optional(),
    to: isoDate({ endOfDay: true }).optional(),
    topic: objectId.optional(),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    message: 'from must not be after to',
    path: ['from'],
  });

export const sessionStatsQuerySchema = z.object({
  range: z.enum(['week', 'month']).default('week'),
});

/* ------------------------------ Suggestions ---------------------------- */

export const suggestionsQuerySchema = z.object({ ...paginationQuery });
