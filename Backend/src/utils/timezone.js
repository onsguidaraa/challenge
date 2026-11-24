/**
 * Small timezone helpers built on Intl (no dependency). A "day key" is a calendar day
 * in a given IANA timezone, written "YYYY-MM-DD". Comparing day keys (instead of
 * subtracting timestamps) keeps day maths correct across DST changes.
 */

export const DEFAULT_TIMEZONE = 'UTC';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const formatters = new Map();

const getFormatter = (timeZone) => {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
};

/**
 * Returns the canonical timezone name ("europe/paris" -> "Europe/Paris"), or null if the
 * value is not a valid IANA timezone. Canonical names are what MongoDB expects too.
 */
export const normalizeTimeZone = (value) => {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value.trim() }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
};

export const isValidTimeZone = (value) => normalizeTimeZone(value) !== null;

/** Calendar fields of `date` as seen in `timeZone`. */
export const zonedParts = (date, timeZone = DEFAULT_TIMEZONE) => {
  const parts = Object.fromEntries(
    getFormatter(timeZone)
      .formatToParts(date)
      .map(({ type, value }) => [type, Number(value)]),
  );
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
};

const pad = (n, size = 2) => String(n).padStart(size, '0');

/** "2026-05-01": the calendar day of `date` in `timeZone`. */
export const toDayKey = (date, timeZone = DEFAULT_TIMEZONE) => {
  const { year, month, day } = zonedParts(date, timeZone);
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
};

/** Hour of day (0-23) of `date` in `timeZone`. */
export const zonedHour = (date, timeZone = DEFAULT_TIMEZONE) => zonedParts(date, timeZone).hour;

const keyToUtcMs = (key) => {
  const [year, month, day] = key.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
};

/** Whole calendar days from `fromKey` to `toKey` (negative when `toKey` is earlier). */
export const dayDiff = (fromKey, toKey) =>
  Math.round((keyToUtcMs(toKey) - keyToUtcMs(fromKey)) / MS_PER_DAY);

export const addDaysToKey = (key, days) =>
  new Date(keyToUtcMs(key) + days * MS_PER_DAY).toISOString().slice(0, 10);

/** 0 = Sunday ... 6 = Saturday, for a day key (timezone independent). */
const weekdayOfKey = (key) => new Date(keyToUtcMs(key)).getUTCDay();

/** Offset of `timeZone` from UTC at `date`, in ms (local time minus UTC). */
const offsetMs = (date, timeZone) => {
  const { year, month, day, hour, minute, second } = zonedParts(date, timeZone);
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
};

/** The instant at which the day `key` starts (00:00 local time) in `timeZone`. */
export const startOfZonedDay = (key, timeZone = DEFAULT_TIMEZONE) => {
  const utcMidnight = keyToUtcMs(key);
  // Two passes: the offset at the first guess can differ from the one at the result around DST.
  let instant = utcMidnight - offsetMs(new Date(utcMidnight), timeZone);
  instant = utcMidnight - offsetMs(new Date(instant), timeZone);
  return new Date(instant);
};

/**
 * Monday-to-Sunday weeks in `timeZone`.
 * @returns {{ thisWeek: {start: Date, end: Date}, lastWeek: {start: Date, end: Date} }}
 *   `end` is exclusive (the start of the next week).
 */
export const getWeekWindows = (now = new Date(), timeZone = DEFAULT_TIMEZONE) => {
  const todayKey = toDayKey(now, timeZone);
  const sinceMonday = (weekdayOfKey(todayKey) + 6) % 7;
  const thisKey = addDaysToKey(todayKey, -sinceMonday);
  const lastKey = addDaysToKey(thisKey, -7);
  const nextKey = addDaysToKey(thisKey, 7);

  const thisStart = startOfZonedDay(thisKey, timeZone);
  return {
    thisWeek: { start: thisStart, end: startOfZonedDay(nextKey, timeZone) },
    lastWeek: { start: startOfZonedDay(lastKey, timeZone), end: thisStart },
  };
};
