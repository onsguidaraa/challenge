export const REVIEW_RATINGS = ['again', 'hard', 'good', 'easy'];

export const MIN_EASE_FACTOR = 1.3;
export const DEFAULT_EASE_FACTOR = 2.5;
/** A card answered with "again" comes back after this many minutes (same session). */
export const LAPSE_RELEARN_MINUTES = 10;

/** SM-2 quality grades (0-5) for each rating. "again" is a lapse (< 3). */
const QUALITY = { again: 1, hard: 3, good: 4, easy: 5 };

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

const round2 = (value) => Math.round(value * 100) / 100;

/**
 * Pure SM-2 style scheduler. Does not read the clock or touch the database.
 *
 * - again (lapse): repetitions reset to 0, intervalDays 0, due again in
 *   LAPSE_RELEARN_MINUTES minutes, easeFactor drops by 0.2.
 * - hard / good / easy: repetitions + 1. Interval is 1 day, then 6 days, then
 *   previous interval * (updated) easeFactor, rounded. easeFactor follows the
 *   SM-2 formula EF + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)): hard -0.14,
 *   good +0, easy +0.1.
 * - easeFactor never goes below MIN_EASE_FACTOR (1.3).
 *
 * @param {{ easeFactor?: number, intervalDays?: number, repetitions?: number }} card
 * @param {'again'|'hard'|'good'|'easy'} rating
 * @param {Date} [now]
 * @returns {{ easeFactor: number, intervalDays: number, repetitions: number, nextReview: Date }}
 */
export const scheduleReview = (card, rating, now = new Date()) => {
  if (!(rating in QUALITY)) throw new RangeError(`Unknown rating "${rating}"`);

  const easeFactor = card.easeFactor ?? DEFAULT_EASE_FACTOR;
  const intervalDays = card.intervalDays ?? 0;
  const repetitions = card.repetitions ?? 0;

  if (rating === 'again') {
    return {
      easeFactor: round2(Math.max(MIN_EASE_FACTOR, easeFactor - 0.2)),
      intervalDays: 0,
      repetitions: 0,
      nextReview: new Date(now.getTime() + LAPSE_RELEARN_MINUTES * MS_PER_MINUTE),
    };
  }

  const q = QUALITY[rating];
  const nextEase = round2(
    Math.max(MIN_EASE_FACTOR, easeFactor + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))),
  );
  const nextRepetitions = repetitions + 1;

  let nextInterval;
  if (nextRepetitions === 1) nextInterval = 1;
  else if (nextRepetitions === 2) nextInterval = 6;
  else nextInterval = Math.max(intervalDays + 1, Math.round(intervalDays * nextEase));

  return {
    easeFactor: nextEase,
    intervalDays: nextInterval,
    repetitions: nextRepetitions,
    nextReview: new Date(now.getTime() + nextInterval * MS_PER_DAY),
  };
};
