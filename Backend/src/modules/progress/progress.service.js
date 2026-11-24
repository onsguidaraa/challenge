import mongoose from 'mongoose';
import { Subject, Topic } from '../space/space.model.js';
import { getOwnedSubject, getOwnedTopic } from '../space/space.service.js';
import { Lesson } from '../lessons/lessons.model.js';
import { Attempt } from '../practice/practice.model.js';
import { Mistake } from '../mistakes/mistakes.model.js';
import { Task, StudySession } from '../planner/planner.model.js';
import { ActivityLog } from '../activity-log/activity-log.model.js';
import { User } from '../auth/auth.model.js';
import { getDisplayStreak, getUserTimezone } from './streak.service.js';
import { paginate, pageResult } from '../../utils/pagination.js';
import { addDaysToKey, getWeekWindows, startOfZonedDay, toDayKey } from '../../utils/timezone.js';

/*
 * Every query here is scoped by `user`. Ids that come from the URL or query string
 * (subject, topic) are first resolved with the owner checks of the space module, so an id
 * of another user behaves exactly like an id that does not exist (404).
 *
 * Aggregation pipelines do not cast values, hence `oid`.
 */

/** Aggregation pipelines do not cast ids, so make sure we pass real ObjectIds. */
const oid = (id) => new mongoose.Types.ObjectId(String(id));

const round1 = (value) => Math.round(value * 10) / 10;

const roundOrNull = (value, rounder = round1) =>
  value === null || value === undefined ? null : rounder(value);

const percentage = (part, total) => (total > 0 ? Math.round((part / total) * 100) : 0);

/** Percentage change from `previous` to `current`; null when it is undefined (no baseline). */
export const percentChange = (current, previous) => {
  if (current === null || current === undefined || previous === null || previous === undefined) {
    return null;
  }
  if (previous === 0) return current === 0 ? 0 : null;
  return round1(((current - previous) / previous) * 100);
};

/* --------------------------------- Trend --------------------------------- */

/** The trend looks at this many most recent attempts. */
export const TREND_WINDOW = 10;
/** Fewer attempts than this is not enough to call a direction. */
export const TREND_MIN_ATTEMPTS = 4;
/** The newer half must beat (or trail) the older half by this many points to count. */
export const TREND_THRESHOLD = 5;

const average = (values) => values.reduce((sum, v) => sum + v, 0) / values.length;

/**
 * Trend of quiz scores. The most recent TREND_WINDOW attempts are split in two halves
 * (a middle attempt of an odd count is left out) and their averages compared:
 * newer - older >= 5 points is "improving", <= -5 is "declining", anything else "stable".
 * Fewer than TREND_MIN_ATTEMPTS attempts is "stable" (nothing to compare yet).
 *
 * @param {number[]} percentages score percentages, oldest first
 * @returns {{ trend: 'improving'|'stable'|'declining', sampleSize: number,
 *   previousAverage: number|null, recentAverage: number|null, change: number|null }}
 */
export const calculateTrend = (percentages) => {
  const recent = percentages.slice(-TREND_WINDOW);
  if (recent.length < TREND_MIN_ATTEMPTS) {
    return {
      trend: 'stable',
      sampleSize: recent.length,
      previousAverage: null,
      recentAverage: null,
      change: null,
    };
  }

  const half = Math.floor(recent.length / 2);
  const previousAverage = average(recent.slice(0, half));
  const recentAverage = average(recent.slice(-half));
  const change = recentAverage - previousAverage;

  let trend = 'stable';
  if (change >= TREND_THRESHOLD) trend = 'improving';
  else if (change <= -TREND_THRESHOLD) trend = 'declining';

  return {
    trend,
    sampleSize: recent.length,
    previousAverage: round1(previousAverage),
    recentAverage: round1(recentAverage),
    change: round1(change),
  };
};

/* --------------------------------- Labels -------------------------------- */

const FORMAT_LABELS = {
  simplified: 'simplified',
  diagram: 'diagram',
  steps: 'step-by-step',
  examples: 'examples',
};

/** A readable one-line description of an activity event. */
export const describeActivity = (type, metadata = {}) => {
  const meta = metadata || {};
  switch (type) {
    case 'lesson_opened':
      return FORMAT_LABELS[meta.format]
        ? `Opened a lesson (${FORMAT_LABELS[meta.format]} format)`
        : 'Opened a lesson';
    case 'lesson_completed':
      return 'Completed a lesson';
    case 'quiz_submitted':
      return typeof meta.percentage === 'number'
        ? `Submitted a quiz (scored ${round1(meta.percentage)}%)`
        : 'Submitted a quiz';
    case 'flashcard_reviewed':
      return meta.rating ? `Reviewed a flashcard (${meta.rating})` : 'Reviewed a flashcard';
    case 'session_started':
      return 'Started a study session';
    case 'session_finished':
      return typeof meta.durationMinutes === 'number'
        ? `Finished a study session (${round1(meta.durationMinutes)} min)`
        : 'Finished a study session';
    case 'task_completed':
      return 'Completed a task';
    case 'onboarding_completed':
      return meta.retake ? 'Retook the onboarding questionnaire' : 'Completed onboarding';
    default:
      return type;
  }
};

/* --------------------------------- Summary ------------------------------- */

/**
 * GET /progress/summary. "This week" is Monday to Sunday in the user's timezone (UTC when
 * none is stored).
 */
export const getSummary = async (userId, { now = new Date() } = {}) => {
  const user = oid(userId);
  const timezone = await getUserTimezone(user);
  const { thisWeek } = getWeekWindows(now, timezone);

  const [lessons, topics, quizzes, study, flashcardsReviewed, unresolvedMistakes, tasks, owner] =
    await Promise.all([
      Lesson.aggregate([
        { $match: { user } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            completed: { $sum: { $cond: ['$completed', 1, 0] } },
          },
        },
      ]),
      Topic.aggregate([
        { $match: { user } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          },
        },
      ]),
      Attempt.aggregate([
        { $match: { user } },
        { $group: { _id: null, taken: { $sum: 1 }, average: { $avg: '$percentage' } } },
      ]),
      StudySession.aggregate([
        { $match: { user, status: 'completed' } },
        {
          $group: {
            _id: null,
            allTime: { $sum: '$durationMinutes' },
            thisWeek: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $gte: ['$startedAt', thisWeek.start] },
                      { $lt: ['$startedAt', thisWeek.end] },
                    ],
                  },
                  '$durationMinutes',
                  0,
                ],
              },
            },
          },
        },
      ]),
      ActivityLog.countDocuments({ user, type: 'flashcard_reviewed' }),
      Mistake.countDocuments({ user, resolved: false }),
      Task.countDocuments({
        user,
        status: 'done',
        completedAt: { $gte: thisWeek.start, $lt: thisWeek.end },
      }),
      User.findById(user).select('streak').lean(),
    ]);

  const lessonRow = lessons[0] ?? { total: 0, completed: 0 };
  const topicRow = topics[0] ?? { total: 0, completed: 0 };
  const quizRow = quizzes[0] ?? { taken: 0, average: null };
  const studyRow = study[0] ?? { allTime: 0, thisWeek: 0 };
  const streak = getDisplayStreak(owner?.streak, now, timezone);

  return {
    timezone,
    week: { start: thisWeek.start, end: thisWeek.end },
    lessons: {
      completed: lessonRow.completed,
      total: lessonRow.total,
      percentage: percentage(lessonRow.completed, lessonRow.total),
    },
    topics: {
      completed: topicRow.completed,
      total: topicRow.total,
      percentage: percentage(topicRow.completed, topicRow.total),
    },
    quizzes: { taken: quizRow.taken, averageScore: roundOrNull(quizRow.average) },
    studyMinutes: { thisWeek: round1(studyRow.thisWeek), allTime: round1(studyRow.allTime) },
    streak: {
      current: streak.current,
      longest: streak.longest,
      lastActiveDate: streak.lastActiveDate,
    },
    flashcardsReviewed,
    unresolvedMistakes,
    tasksCompletedThisWeek: tasks,
  };
};

/* --------------------------------- Subjects ------------------------------ */

/** Collection name of topics, for $lookup stages. */
const topicsCollection = () => Topic.collection.name;

/** Joins each document's `topic` to its topic and groups by the topic's subject. */
const bySubject = (user, subjectIds, match, accumulators) => [
  { $match: { user, ...match } },
  {
    $lookup: {
      from: topicsCollection(),
      localField: 'topic',
      foreignField: '_id',
      pipeline: [{ $match: { user, subject: { $in: subjectIds } } }, { $project: { subject: 1 } }],
      as: 'topicDoc',
    },
  },
  { $unwind: '$topicDoc' },
  { $group: { _id: '$topicDoc.subject', ...accumulators } },
];

export const getSubjectsProgress = async (userId, query) => {
  const user = oid(userId);
  const filter = { user };
  const { skip, limit } = paginate(query);

  const [subjects, total] = await Promise.all([
    Subject.find(filter)
      .sort({ name: 1, _id: 1 })
      .collation({ locale: 'en', strength: 2 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Subject.countDocuments(filter),
  ]);
  const subjectIds = subjects.map((s) => s._id);

  const [topicRows, attemptRows, studyRows] = subjectIds.length
    ? await Promise.all([
        Topic.aggregate([
          { $match: { user, subject: { $in: subjectIds } } },
          {
            $group: {
              _id: '$subject',
              total: { $sum: 1 },
              completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
            },
          },
        ]),
        Attempt.aggregate(
          bySubject(
            user,
            subjectIds,
            {},
            {
              attempts: { $sum: 1 },
              average: { $avg: '$percentage' },
            },
          ),
        ),
        StudySession.aggregate(
          bySubject(
            user,
            subjectIds,
            { status: 'completed' },
            {
              minutes: { $sum: '$durationMinutes' },
            },
          ),
        ),
      ])
    : [[], [], []];

  const topicsBy = new Map(topicRows.map((r) => [String(r._id), r]));
  const attemptsBy = new Map(attemptRows.map((r) => [String(r._id), r]));
  const studyBy = new Map(studyRows.map((r) => [String(r._id), r]));

  const items = subjects.map((subject) => {
    const key = String(subject._id);
    const topics = topicsBy.get(key) ?? { total: 0, completed: 0 };
    const attempts = attemptsBy.get(key);
    return {
      id: key,
      name: subject.name,
      color: subject.color,
      icon: subject.icon,
      archived: subject.archived,
      topics: { completed: topics.completed, total: topics.total },
      progressPercentage: percentage(topics.completed, topics.total),
      quizAttempts: attempts?.attempts ?? 0,
      averageScore: roundOrNull(attempts?.average),
      studyMinutes: round1(studyBy.get(key)?.minutes ?? 0),
    };
  });

  return pageResult(items, query, total);
};

/** Topic-level detail of one subject. 404 when the subject is not the user's. */
export const getSubjectProgress = async (userId, subjectId) => {
  const user = oid(userId);
  const subject = await getOwnedSubject(user, subjectId);

  const topics = await Topic.find({ user, subject: subject._id }).sort({ order: 1, _id: 1 }).lean();
  const topicIds = topics.map((t) => t._id);

  const [attemptRows, studyRows, mistakeRows, lessons] = topicIds.length
    ? await Promise.all([
        Attempt.aggregate([
          { $match: { user, topic: { $in: topicIds } } },
          { $sort: { createdAt: 1, _id: 1 } },
          {
            $group: {
              _id: '$topic',
              attempts: { $sum: 1 },
              average: { $avg: '$percentage' },
              best: { $max: '$percentage' },
              last: { $last: '$percentage' },
              lastAttemptAt: { $last: '$createdAt' },
            },
          },
        ]),
        StudySession.aggregate([
          { $match: { user, status: 'completed', topic: { $in: topicIds } } },
          { $group: { _id: '$topic', minutes: { $sum: '$durationMinutes' } } },
        ]),
        Mistake.aggregate([
          { $match: { user, resolved: false, topic: { $in: topicIds } } },
          { $group: { _id: '$topic', count: { $sum: 1 } } },
        ]),
        Lesson.find({ user, topic: { $in: topicIds } })
          .select('topic completed')
          .lean(),
      ])
    : [[], [], [], []];

  const attemptsBy = new Map(attemptRows.map((r) => [String(r._id), r]));
  const studyBy = new Map(studyRows.map((r) => [String(r._id), r.minutes]));
  const mistakesBy = new Map(mistakeRows.map((r) => [String(r._id), r.count]));
  const lessonBy = new Map(lessons.map((l) => [String(l.topic), l]));

  const items = topics.map((topic) => {
    const key = String(topic._id);
    const attempts = attemptsBy.get(key);
    const lesson = lessonBy.get(key);
    return {
      id: key,
      title: topic.title,
      order: topic.order,
      status: topic.status,
      difficulty: topic.difficulty,
      hasLesson: Boolean(lesson),
      lessonCompleted: Boolean(lesson?.completed),
      quizAttempts: attempts?.attempts ?? 0,
      averageScore: roundOrNull(attempts?.average),
      bestScore: roundOrNull(attempts?.best),
      lastScore: roundOrNull(attempts?.last),
      lastAttemptAt: attempts?.lastAttemptAt ?? null,
      studyMinutes: round1(studyBy.get(key) ?? 0),
      unresolvedMistakes: mistakesBy.get(key) ?? 0,
    };
  });

  const completed = items.filter((t) => t.status === 'completed').length;
  const attempted = items.filter((t) => t.quizAttempts > 0);
  const totalAttempts = attempted.reduce((sum, t) => sum + t.quizAttempts, 0);
  const weightedScore = attempted.reduce(
    (sum, t) => sum + attemptsBy.get(t.id).average * t.quizAttempts,
    0,
  );

  return {
    subject: {
      id: String(subject._id),
      name: subject.name,
      color: subject.color,
      icon: subject.icon,
      archived: subject.archived,
    },
    topics: { completed, total: items.length },
    progressPercentage: percentage(completed, items.length),
    quizAttempts: totalAttempts,
    averageScore: totalAttempts ? round1(weightedScore / totalAttempts) : null,
    studyMinutes: round1(items.reduce((sum, t) => sum + t.studyMinutes, 0)),
    unresolvedMistakes: items.reduce((sum, t) => sum + t.unresolvedMistakes, 0),
    items,
  };
};

/* --------------------------------- Quizzes ------------------------------- */

const dateRangeFilter = (field, { from, to }) => {
  if (!from && !to) return {};
  const range = {};
  if (from) range.$gte = from;
  if (to) range.$lte = to;
  return { [field]: range };
};

/**
 * Quiz score history (newest first, paginated) with the overall average / best and the
 * trend. The average, best and trend cover the whole filtered range, not only the page.
 */
export const getQuizHistory = async (userId, query) => {
  const user = oid(userId);
  const filter = { user, ...dateRangeFilter('createdAt', query) };
  if (query.topic) filter.topic = (await getOwnedTopic(user, query.topic))._id;

  const { skip, limit } = paginate(query);
  const [attempts, total, [stats], latest] = await Promise.all([
    Attempt.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
    Attempt.countDocuments(filter),
    Attempt.aggregate([
      { $match: filter },
      { $group: { _id: null, average: { $avg: '$percentage' }, best: { $max: '$percentage' } } },
    ]),
    Attempt.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(TREND_WINDOW)
      .select('percentage')
      .lean(),
  ]);

  const { trend, ...trendDetails } = calculateTrend(latest.map((a) => a.percentage).reverse());

  const items = attempts.map((a) => ({
    id: String(a._id),
    quizId: String(a.quiz),
    topicId: String(a.topic),
    score: a.score,
    maxScore: a.maxScore,
    percentage: a.percentage,
    durationSeconds: a.durationSeconds,
    createdAt: a.createdAt,
  }));

  return {
    ...pageResult(items, query, total),
    averageScore: roundOrNull(stats?.average),
    bestScore: roundOrNull(stats?.best),
    trend,
    trendDetails,
  };
};

/* --------------------------------- Activity ------------------------------ */

export const getActivityTimeline = async (userId, query) => {
  const user = oid(userId);
  const filter = { user, ...dateRangeFilter('createdAt', query) };
  if (query.type) filter.type = { $in: query.type };

  const { skip, limit } = paginate(query);
  const [events, total] = await Promise.all([
    ActivityLog.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
    ActivityLog.countDocuments(filter),
  ]);

  const items = events.map((event) => ({
    id: String(event._id),
    type: event.type,
    label: describeActivity(event.type, event.metadata),
    refId: event.refId ? String(event.refId) : null,
    refModel: event.refModel ?? null,
    metadata: event.metadata ?? {},
    createdAt: event.createdAt,
  }));
  return pageResult(items, query, total);
};

/* --------------------------------- Heatmap ------------------------------- */

/** 0 = no activity, 1-4 = quartiles of the busiest day, for colouring a calendar. */
const heatLevel = (count, max) =>
  count <= 0 || max <= 0 ? 0 : Math.min(4, Math.ceil((count / max) * 4));

/**
 * Activity events per calendar day (in the user's timezone) for the last `days` days,
 * today included. Days without activity are returned with count 0 so the list is gapless.
 */
export const getHeatmap = async (userId, { days }, { now = new Date() } = {}) => {
  const user = oid(userId);
  const timezone = await getUserTimezone(user);

  const toKey = toDayKey(now, timezone);
  const fromKey = addDaysToKey(toKey, -(days - 1));

  const rows = await ActivityLog.aggregate([
    { $match: { user, createdAt: { $gte: startOfZonedDay(fromKey, timezone), $lte: now } } },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone } },
        count: { $sum: 1 },
      },
    },
  ]);
  const countByDay = new Map(rows.map((r) => [r._id, r.count]));

  const counts = [];
  for (let i = 0; i < days; i += 1) {
    const date = addDaysToKey(fromKey, i);
    counts.push({ date, count: countByDay.get(date) ?? 0 });
  }
  const max = Math.max(0, ...counts.map((c) => c.count));

  return {
    days,
    timezone,
    from: fromKey,
    to: toKey,
    totalActivities: counts.reduce((sum, c) => sum + c.count, 0),
    activeDays: counts.filter((c) => c.count > 0).length,
    maxCount: max,
    items: counts.map((c) => ({ ...c, level: heatLevel(c.count, max) })),
  };
};

/* ------------------------------ Weekly report ---------------------------- */

/** Splits the range into this/last week with a $cond, so one pipeline serves both weeks. */
const weekBucket = (field, thisWeekStart) => ({
  $cond: [{ $gte: [field, thisWeekStart] }, 'thisWeek', 'lastWeek'],
});

const emptyWeek = () => ({ studyMinutes: 0, quizzes: 0, averageScore: null, lessonsCompleted: 0 });

const CHANGE_FIELDS = ['studyMinutes', 'quizzes', 'averageScore', 'lessonsCompleted'];

/**
 * This week vs last week (Monday to Sunday in the user's timezone). `change` is the change
 * in percent from last week; it is null when last week has nothing to compare against
 * (e.g. 0 quizzes last week and 3 this week). `difference` is the absolute change.
 */
export const getWeeklyReport = async (userId, { now = new Date() } = {}) => {
  const user = oid(userId);
  const timezone = await getUserTimezone(user);
  const { thisWeek, lastWeek } = getWeekWindows(now, timezone);
  const range = (field) => ({ [field]: { $gte: lastWeek.start, $lt: thisWeek.end } });

  const [attempts, sessions, lessons] = await Promise.all([
    Attempt.aggregate([
      { $match: { user, ...range('createdAt') } },
      {
        $group: {
          _id: weekBucket('$createdAt', thisWeek.start),
          quizzes: { $sum: 1 },
          average: { $avg: '$percentage' },
        },
      },
    ]),
    StudySession.aggregate([
      { $match: { user, status: 'completed', ...range('startedAt') } },
      {
        $group: {
          _id: weekBucket('$startedAt', thisWeek.start),
          minutes: { $sum: '$durationMinutes' },
        },
      },
    ]),
    Lesson.aggregate([
      { $match: { user, completed: true, ...range('completedAt') } },
      { $group: { _id: weekBucket('$completedAt', thisWeek.start), count: { $sum: 1 } } },
    ]),
  ]);

  const weeks = { thisWeek: emptyWeek(), lastWeek: emptyWeek() };
  for (const row of attempts) {
    weeks[row._id].quizzes = row.quizzes;
    weeks[row._id].averageScore = round1(row.average);
  }
  for (const row of sessions) weeks[row._id].studyMinutes = round1(row.minutes);
  for (const row of lessons) weeks[row._id].lessonsCompleted = row.count;

  const change = {};
  const difference = {};
  for (const field of CHANGE_FIELDS) {
    const current = weeks.thisWeek[field];
    const previous = weeks.lastWeek[field];
    change[field] = percentChange(current, previous);
    difference[field] = current === null || previous === null ? null : round1(current - previous);
  }

  return {
    timezone,
    thisWeek: { start: thisWeek.start, end: thisWeek.end, ...weeks.thisWeek },
    lastWeek: { start: lastWeek.start, end: lastWeek.end, ...weeks.lastWeek },
    change,
    difference,
  };
};
