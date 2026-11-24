import mongoose from 'mongoose';
import { Profile, LEARNED_FORMATS } from './profile.model.js';
import { ActivityLog } from '../activity-log/activity-log.model.js';
import { Mistake } from '../mistakes/mistakes.model.js';
import { Attempt } from '../practice/practice.model.js';
import { Topic } from '../space/space.model.js';
import { env } from '../../config/env.js';
import { ApiError } from '../../utils/ApiError.js';
import { logger } from '../../utils/logger.js';
import { DEFAULT_TIMEZONE } from '../../utils/timezone.js';

const notFound = () =>
  ApiError.notFound('Learning profile not found. Complete onboarding first.', {
    code: 'PROFILE_NOT_FOUND',
  });

/** Flattens `{ studyHabits: { a: 1 } }` into `{ 'studyHabits.a': 1 }` so partial updates merge. */
const flatten = (input) => {
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (key === 'studyHabits') {
      for (const [k, v] of Object.entries(value)) {
        if (v !== undefined) out[`studyHabits.${k}`] = v;
      }
    } else {
      out[key] = value;
    }
  }
  return out;
};

export const getProfile = async (userId) => {
  const profile = await Profile.findOne({ user: userId });
  if (!profile) throw notFound();
  return profile;
};

/** Returns the profile or null (no error). */
export const findProfile = (userId) => Profile.findOne({ user: userId });

/**
 * Creates or replaces the user-editable answers. learnedStats is never touched.
 * Used by onboarding (first time and retake).
 */
export const upsertProfileAnswers = async (userId, answers) => {
  const { studyHabits, ...rest } = answers;
  return Profile.findOneAndUpdate(
    { user: userId },
    { $set: { ...rest, studyHabits } },
    { upsert: true, returnDocument: 'after', runValidators: true, setDefaultsOnInsert: true },
  );
};

export const updateProfile = async (userId, changes) => {
  const update = flatten(changes);
  const profile = await Profile.findOneAndUpdate(
    { user: userId },
    { $set: update },
    { returnDocument: 'after', runValidators: true },
  );
  if (!profile) throw notFound();
  return profile;
};

const FORMAT_LABELS = {
  simplified: 'plain-language',
  visual: 'visual',
  step_by_step: 'step-by-step',
  examples: 'example-driven',
  practice: 'hands-on',
};

const TIME_LABELS = {
  morning: 'in the morning',
  afternoon: 'in the afternoon',
  evening: 'in the evening',
  night: 'at night',
};

const joinList = (items) =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

const LEARNED_FORMAT_LABELS = {
  simplified: 'simplified',
  diagram: 'diagram',
  steps: 'step-by-step',
  examples: 'example-based',
};

/**
 * @param {object} profile
 * @param {{ weakTopicTitles?: string[] }} [extras] topic names for learnedStats.weakTopics
 *   (the profile only stores ids). Learned clauses only appear once there is data for them.
 */
export const buildSummary = (profile, { weakTopicTitles = [] } = {}) => {
  const parts = [];

  const formats = (profile.preferredFormats || []).map((f) => FORMAT_LABELS[f]).filter(Boolean);
  if (formats.length) {
    const text = `${joinList(formats)} learner`;
    parts.push(text.charAt(0).toUpperCase() + text.slice(1));
  } else {
    parts.push('Learner');
  }

  const habits = profile.studyHabits || {};
  if (habits.bestTimeOfDay) parts.push(`studies best ${TIME_LABELS[habits.bestTimeOfDay]}`);
  if (habits.preferredSessionMinutes) {
    parts.push(`prefers ${habits.preferredSessionMinutes}-minute sessions`);
  }
  if (profile.difficulties?.length) {
    parts.push(`struggles with: ${profile.difficulties.join(', ')}`);
  }

  // What the activity log shows, which can differ from what the student answered.
  const learned = profile.learnedStats || {};
  if (learned.dominantFormat) {
    parts.push(`mostly opens ${LEARNED_FORMAT_LABELS[learned.dominantFormat]} lessons`);
  }
  if (learned.recommendedBestTime && learned.recommendedBestTime !== habits.bestTimeOfDay) {
    parts.push(`is actually most active ${TIME_LABELS[learned.recommendedBestTime]}`);
  }
  if (learned.avgSessionMinutes) {
    parts.push(`averages ${learned.avgSessionMinutes}-minute sessions`);
  }
  if (weakTopicTitles.length) {
    parts.push(`needs practice on: ${weakTopicTitles.join(', ')}`);
  }

  return parts.join(', ');
};

/** How many topic names the summary mentions. */
const SUMMARY_WEAK_TOPICS = 3;

/**
 * Human readable summary built from the onboarding answers and the computed learnedStats.
 * The stats are refreshed first (debounced, so this is cheap when they are recent).
 */
export const getProfileSummary = async (userId) => {
  let profile = await getProfile(userId);

  try {
    profile = (await recomputeLearnedStats(userId)) ?? profile;
  } catch (err) {
    // Derived data must not break the read: fall back to what is stored.
    logger.error('Failed to recompute learned stats', { error: err?.message });
  }

  const weakTopicIds = profile.learnedStats?.weakTopics ?? [];
  const topics = weakTopicIds.length
    ? await Topic.find({ _id: { $in: weakTopicIds }, user: userId })
        .select('title')
        .lean()
    : [];
  const titleById = new Map(topics.map((t) => [String(t._id), t.title]));
  // Keep the weakness order; skip topics that were deleted since.
  const weakTopics = weakTopicIds
    .filter((id) => titleById.has(String(id)))
    .map((id) => ({ id: String(id), title: titleById.get(String(id)) }));

  const { learnedStats } = profile.toJSON();
  return {
    summary: buildSummary(profile, {
      weakTopicTitles: weakTopics.slice(0, SUMMARY_WEAK_TOPICS).map((t) => t.title),
    }),
    learnedStats,
    weakTopics,
  };
};

/* --------------------------- Learned stats (DNA) --------------------------- */

/** How many topics are kept in learnedStats.weakTopics. */
const WEAK_TOPICS_LIMIT = 10;
/** A topic is weak by score when its average is below this percentage... */
export const LOW_SCORE_THRESHOLD = 60;
/** ...over at least this many quiz attempts. */
export const LOW_SCORE_MIN_ATTEMPTS = 2;

/**
 * Weak topics, worst first:
 * 1. topics with unresolved Mistake Notebook entries (most mistakes first), then
 * 2. other topics whose average quiz score is below LOW_SCORE_THRESHOLD over at least
 *    LOW_SCORE_MIN_ATTEMPTS attempts (lowest average first).
 * Capped at WEAK_TOPICS_LIMIT.
 */
const computeWeakTopics = async (userId) => {
  const [{ rows }, lowScoring] = await Promise.all([
    Mistake.rankWeakTopics(userId, { limit: WEAK_TOPICS_LIMIT }),
    Attempt.aggregate([
      { $match: { user: userId } },
      { $group: { _id: '$topic', average: { $avg: '$percentage' }, attempts: { $sum: 1 } } },
      {
        $match: {
          attempts: { $gte: LOW_SCORE_MIN_ATTEMPTS },
          average: { $lt: LOW_SCORE_THRESHOLD },
        },
      },
      { $sort: { average: 1, _id: 1 } },
      { $limit: WEAK_TOPICS_LIMIT },
    ]),
  ]);

  const ids = rows.map((row) => row.topicId);
  const seen = new Set(ids.map(String));
  for (const { _id } of lowScoring) {
    if (!seen.has(String(_id))) ids.push(_id);
  }
  return ids.slice(0, WEAK_TOPICS_LIMIT);
};

const toMinutes = (ms) => Math.round((ms / 60000) * 10) / 10;

/**
 * Event conventions read by recomputeLearnedStats:
 * - lesson_opened: metadata.format in simplified | diagram | steps | examples
 * - session_finished: metadata.durationMinutes (number). If missing, the duration
 *   is derived from the session_started event with the same refId.
 * - Active hour = hour of day (in the user's timezone, UTC by default) of every event
 *   except onboarding_completed.
 */
const computeFormatUsage = async (userId) => {
  const rows = await ActivityLog.aggregate([
    {
      $match: {
        user: userId,
        type: 'lesson_opened',
        'metadata.format': { $in: LEARNED_FORMATS },
      },
    },
    { $group: { _id: '$metadata.format', count: { $sum: 1 } } },
  ]);
  const usage = Object.fromEntries(LEARNED_FORMATS.map((k) => [k, 0]));
  for (const { _id, count } of rows) usage[_id] = count;
  return usage;
};

/** The most used format, or null when nothing was opened. Ties go to the earlier format. */
export const pickDominantFormat = (usage) => {
  let best = null;
  let bestCount = 0;
  for (const format of LEARNED_FORMATS) {
    if ((usage?.[format] ?? 0) > bestCount) {
      best = format;
      bestCount = usage[format];
    }
  }
  return best;
};

/** Part of the day (an onboarding `bestTimeOfDay` value) an hour 0-23 falls in. */
export const timeOfDayForHour = (hour) => {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 22) return 'evening';
  return 'night';
};

const computeAvgSessionMinutes = async (userId) => {
  const finished = await ActivityLog.find({ user: userId, type: 'session_finished' })
    .select('refId metadata createdAt')
    .lean();
  if (!finished.length) return null;

  const needStart = finished.filter(
    (e) => !(typeof e.metadata?.durationMinutes === 'number' && e.metadata.durationMinutes >= 0),
  );
  const refIds = needStart.map((e) => e.refId).filter(Boolean);
  const starts = refIds.length
    ? await ActivityLog.find({ user: userId, type: 'session_started', refId: { $in: refIds } })
        .select('refId createdAt')
        .lean()
    : [];
  const startByRef = new Map(starts.map((s) => [String(s.refId), s.createdAt]));

  const durations = [];
  for (const event of finished) {
    const explicit = event.metadata?.durationMinutes;
    if (typeof explicit === 'number' && explicit >= 0) {
      durations.push(explicit);
    } else if (event.refId && startByRef.has(String(event.refId))) {
      const ms = event.createdAt - startByRef.get(String(event.refId));
      if (ms >= 0) durations.push(toMinutes(ms));
    }
  }
  if (!durations.length) return null;
  return Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 10) / 10;
};

const computeMostActiveHour = async (userId, timezone) => {
  const rows = await ActivityLog.aggregate([
    { $match: { user: userId, type: { $ne: 'onboarding_completed' } } },
    { $group: { _id: { $hour: { date: '$createdAt', timezone } }, count: { $sum: 1 } } },
    // Ties resolve to the earliest hour so the result is deterministic.
    { $sort: { count: -1, _id: 1 } },
    { $limit: 1 },
  ]);
  return rows.length ? rows[0]._id : null;
};

/**
 * Recomputes learnedStats from the user's ActivityLog, quiz attempts and Mistake Notebook.
 *
 * Idempotent: values are derived from scratch on every call (no incremental
 * counters), so repeated calls with no new events yield the same stats
 * (only lastComputedAt moves). Safe to call any time: returns null if the user
 * has no profile yet, and only $sets the fields it owns.
 *
 * Debounced: unless `force` is set, a user whose stats were computed less than
 * `minIntervalMs` ago (LEARNED_STATS_MIN_INTERVAL_SECONDS, default 5 minutes) is left as is
 * and the stored profile is returned. The time slot is claimed with one atomic update, so
 * concurrent callers compute at most once.
 *
 * Fields: formatUsage (lesson_opened events), dominantFormat, avgSessionMinutes,
 * mostActiveHour, recommendedBestTime, weakTopics.
 *
 * @param {object} [options]
 * @param {boolean} [options.force] skip the debounce
 * @param {number} [options.minIntervalMs]
 * @param {Date} [options.now]
 */
export const recomputeLearnedStats = async (
  rawUserId,
  {
    force = false,
    minIntervalMs = env.LEARNED_STATS_MIN_INTERVAL_SECONDS * 1000,
    now = new Date(),
  } = {},
) => {
  // Aggregation pipelines do not cast, so make sure we have a real ObjectId.
  if (!mongoose.isValidObjectId(rawUserId)) return null;
  const userId = new mongoose.Types.ObjectId(String(rawUserId));

  let before;
  let claimed = false;
  if (!force && minIntervalMs > 0) {
    before = await Profile.findOneAndUpdate(
      {
        user: userId,
        $or: [
          { 'learnedStats.lastComputedAt': null },
          { 'learnedStats.lastComputedAt': { $lte: new Date(now.getTime() - minIntervalMs) } },
        ],
      },
      { $set: { 'learnedStats.lastComputedAt': now } },
      { returnDocument: 'before' },
    );
    // Either no profile, or computed recently enough.
    if (!before) return Profile.findOne({ user: userId });
    claimed = true;
  } else {
    before = await Profile.findOne({ user: userId });
    if (!before) return null;
  }

  try {
    const timezone = before.timezone || DEFAULT_TIMEZONE;
    const [formatUsage, avgSessionMinutes, mostActiveHour, weakTopics] = await Promise.all([
      computeFormatUsage(userId),
      computeAvgSessionMinutes(userId),
      computeMostActiveHour(userId, timezone),
      computeWeakTopics(userId),
    ]);

    return await Profile.findOneAndUpdate(
      { user: userId },
      {
        $set: {
          'learnedStats.formatUsage': formatUsage,
          'learnedStats.dominantFormat': pickDominantFormat(formatUsage),
          'learnedStats.avgSessionMinutes': avgSessionMinutes,
          'learnedStats.mostActiveHour': mostActiveHour,
          'learnedStats.recommendedBestTime': timeOfDayForHour(mostActiveHour),
          'learnedStats.weakTopics': weakTopics,
          'learnedStats.lastComputedAt': now,
        },
      },
      { returnDocument: 'after' },
    );
  } catch (err) {
    // Release the claimed slot so the next event can retry instead of waiting out the window.
    if (claimed) {
      await Profile.updateOne(
        { user: userId },
        { $set: { 'learnedStats.lastComputedAt': before.learnedStats?.lastComputedAt ?? null } },
      ).catch(() => {});
    }
    throw err;
  }
};

/** POST /profile/recompute: recompute now, ignoring the debounce. 404 without a profile. */
export const forceRecomputeLearnedStats = async (userId) => {
  const profile = await recomputeLearnedStats(userId, { force: true });
  if (!profile) throw notFound();
  return profile;
};
