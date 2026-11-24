/**
 * Pure helpers for the planner (no database, no clock unless passed in), so they are
 * easy to unit test. All date maths is done in UTC.
 */

export const MS_PER_MINUTE = 60 * 1000;
export const MS_PER_HOUR = 60 * MS_PER_MINUTE;
export const MS_PER_DAY = 24 * MS_PER_HOUR;

/** An active session older than this is closed as abandoned when a new one starts. */
export const STALE_SESSION_HOURS = 12;

export const round1 = (value) => Math.round(value * 10) / 10;

export const startOfUtcDay = (date) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

export const endOfUtcDay = (date) => new Date(startOfUtcDay(date).getTime() + MS_PER_DAY - 1);

export const addDays = (date, days) => new Date(date.getTime() + days * MS_PER_DAY);

/** "2026-05-01" (UTC) */
export const toDateKey = (date) => date.toISOString().slice(0, 10);

/**
 * Plan progress as a percentage (0-100, rounded). Skipped tasks are left out of the
 * calculation: a task you decided not to do should neither help nor hurt the plan.
 * A plan with nothing to do yet is at 0%.
 *
 * @param {{ total?: number, done?: number, skipped?: number }} counts
 */
export const calculateProgress = ({ total = 0, done = 0, skipped = 0 } = {}) => {
  const counted = total - skipped;
  if (counted <= 0) return 0;
  return Math.min(100, Math.round((done / counted) * 100));
};

/** Minutes between two dates, rounded to 1 decimal. Never negative. */
export const computeDurationMinutes = (startedAt, endedAt) => {
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  return ms > 0 ? round1(ms / MS_PER_MINUTE) : 0;
};

export const isSessionStale = (startedAt, now = new Date()) =>
  now.getTime() - new Date(startedAt).getTime() >= STALE_SESSION_HOURS * MS_PER_HOUR;

const RECURRENCE_STEP_DAYS = { daily: 1, weekly: 7 };

/**
 * Due date of the next occurrence of a recurring task: the current due date plus one
 * step (1 or 7 days). Returns null when the task does not recur, has no due date, or the
 * next occurrence would fall after `recurrence.until`.
 *
 * @param {{ dueDate?: Date|null, recurrence?: { type?: string, until?: Date|null } }} task
 */
export const nextOccurrenceDate = (task) => {
  const step = RECURRENCE_STEP_DAYS[task.recurrence?.type];
  if (!step || !task.dueDate) return null;
  const next = addDays(new Date(task.dueDate), step);
  const until = task.recurrence.until;
  if (until && next.getTime() > new Date(until).getTime()) return null;
  return next;
};

/**
 * Bounds of a calendar window containing `date`, as [from, to) (`to` is exclusive):
 * - day: that UTC day
 * - week: Monday to Sunday containing the date
 * - month: the calendar month containing the date
 */
export const getRangeBounds = (range, date = new Date()) => {
  const dayStart = startOfUtcDay(date);
  if (range === 'day') return { from: dayStart, to: addDays(dayStart, 1) };

  if (range === 'week') {
    const sinceMonday = (dayStart.getUTCDay() + 6) % 7;
    const from = addDays(dayStart, -sinceMonday);
    return { from, to: addDays(from, 7) };
  }

  if (range === 'month') {
    const year = dayStart.getUTCFullYear();
    const month = dayStart.getUTCMonth();
    return { from: new Date(Date.UTC(year, month, 1)), to: new Date(Date.UTC(year, month + 1, 1)) };
  }

  throw new RangeError(`Unknown range "${range}"`);
};

/**
 * Groups tasks by the UTC date of their due date: [{ date: '2026-05-01', tasks }],
 * dates ascending, tasks ordered by due date (then by their original order).
 * Tasks without a due date are ignored.
 */
export const groupTasksByDate = (tasks) => {
  const groups = new Map();
  const dated = tasks
    .filter((task) => task.dueDate)
    .map((task, index) => ({ task, index }))
    .sort((a, b) => new Date(a.task.dueDate) - new Date(b.task.dueDate) || a.index - b.index);

  for (const { task } of dated) {
    const key = toDateKey(new Date(task.dueDate));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(task);
  }

  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, items]) => ({ date, tasks: items }));
};
