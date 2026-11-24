import { User } from '../auth/auth.model.js';
import { Profile } from '../profile/profile.model.js';
import { DEFAULT_TIMEZONE, dayDiff, toDayKey } from '../../utils/timezone.js';

/** Activity types that keep a streak alive (the "qualifying" activities). */
export const STREAK_ACTIVITY_TYPES = [
  'lesson_completed',
  'quiz_submitted',
  'flashcard_reviewed',
  'session_finished',
];

/** Optimistic-concurrency retries when two events update the same streak at once. */
const MAX_ATTEMPTS = 3;

/**
 * Pure streak maths. Days are calendar days in `timezone`, not 24-hour windows.
 * - never active before: current = 1
 * - same day as lastActiveDate: nothing changes
 * - the next day: current + 1
 * - a gap of more than one day: current resets to 1
 * - an event older than lastActiveDate (late or back-filled): nothing changes
 * `longest` always keeps the best value reached.
 *
 * @returns {{ changed: boolean, current: number, longest: number, lastActiveDate: Date|null }}
 */
export const computeNextStreak = (streak, now, timezone = DEFAULT_TIMEZONE) => {
  const current = streak?.current ?? 0;
  const longest = streak?.longest ?? 0;
  const last = streak?.lastActiveDate ?? null;

  if (!last) {
    return { changed: true, current: 1, longest: Math.max(longest, 1), lastActiveDate: now };
  }

  const gap = dayDiff(toDayKey(new Date(last), timezone), toDayKey(now, timezone));
  if (gap <= 0) return { changed: false, current, longest, lastActiveDate: last };

  const next = gap === 1 ? current + 1 : 1;
  return {
    changed: true,
    current: next,
    longest: Math.max(longest, next),
    lastActiveDate: now,
  };
};

/**
 * The streak as it should be shown today. The stored `current` only changes when the
 * user is active, so after a missed day it would still show the old value: if the last
 * active day is neither today nor yesterday the streak is already broken, so it reads 0.
 */
export const getDisplayStreak = (streak, now = new Date(), timezone = DEFAULT_TIMEZONE) => {
  const last = streak?.lastActiveDate ?? null;
  const longest = streak?.longest ?? 0;
  if (!last) return { current: 0, longest, lastActiveDate: null, activeToday: false };

  const gap = dayDiff(toDayKey(new Date(last), timezone), toDayKey(now, timezone));
  return {
    current: gap <= 1 ? (streak.current ?? 0) : 0,
    longest,
    lastActiveDate: last,
    activeToday: gap === 0,
  };
};

/** The user's stored timezone, or UTC. */
export const getUserTimezone = async (userId) => {
  const profile = await Profile.findOne({ user: userId }).select('timezone').lean();
  return profile?.timezone || DEFAULT_TIMEZONE;
};

/**
 * Registers qualifying activity for `userId` at `now` and updates user.streak.
 * Called by logActivity (which swallows errors); safe to call several times a day.
 *
 * The write is conditional on lastActiveDate being what we read, so two concurrent events
 * cannot both increment the streak: the loser re-reads and sees "same day".
 *
 * @returns the resulting streak { current, longest, lastActiveDate }, or null for an unknown user
 */
export const updateStreak = async (userId, { now = new Date(), timezone } = {}) => {
  const tz = timezone || (await getUserTimezone(userId));

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const user = await User.findById(userId).select('streak').lean();
    if (!user) return null;

    const next = computeNextStreak(user.streak, now, tz);
    const { changed, ...streak } = next;
    if (!changed) return streak;

    const { modifiedCount } = await User.updateOne(
      // `null` also matches a missing field, i.e. a user who was never active.
      { _id: userId, 'streak.lastActiveDate': user.streak?.lastActiveDate ?? null },
      {
        $set: {
          'streak.current': streak.current,
          'streak.longest': streak.longest,
          'streak.lastActiveDate': streak.lastActiveDate,
        },
      },
    );
    if (modifiedCount === 1) return streak;
  }

  // Still contended after several tries: another writer won, so report what is stored.
  const user = await User.findById(userId).select('streak').lean();
  return user?.streak ?? null;
};
