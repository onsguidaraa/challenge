import mongoose from 'mongoose';
import request from 'supertest';
import app from '../src/app.js';
import { User } from '../src/modules/auth/auth.model.js';
import { Profile } from '../src/modules/profile/profile.model.js';
import { Subject, Topic } from '../src/modules/space/space.model.js';
import { Lesson } from '../src/modules/lessons/lessons.model.js';
import { Attempt } from '../src/modules/practice/practice.model.js';
import { Mistake } from '../src/modules/mistakes/mistakes.model.js';
import { Task, StudySession } from '../src/modules/planner/planner.model.js';
import { ActivityLog } from '../src/modules/activity-log/activity-log.model.js';
import {
  calculateTrend,
  describeActivity,
  getHeatmap,
  getSubjectsProgress,
  getSummary,
  getWeeklyReport,
  percentChange,
} from '../src/modules/progress/progress.service.js';
import { startTestDb, clearTestDb, stopTestDb } from './helpers/db.js';
import { API, registerUser, bearer } from './helpers/auth.js';

const oid = () => new mongoose.Types.ObjectId();
const d = (iso) => new Date(iso);
const get = (token, path) => request(app).get(`${API}${path}`).set(bearer(token));

/** A Wednesday. "This week" is 2026-05-11 .. 2026-05-17, last week 2026-05-04 .. 2026-05-10. */
const NOW = d('2026-05-13T12:00:00Z');

beforeAll(async () => {
  await startTestDb();
}, 120000);

afterEach(async () => {
  await clearTestDb();
});

afterAll(async () => {
  await stopTestDb();
});

/* ------------------------------- Seed data ------------------------------- */

const attempt = (user, topic, percentage, createdAt) => ({
  user,
  quiz: oid(),
  topic,
  score: percentage,
  maxScore: 100,
  percentage,
  durationSeconds: 60,
  createdAt,
});

const session = (user, topic, durationMinutes, startedAt, status = 'completed') => ({
  user,
  topic,
  durationMinutes,
  startedAt,
  endedAt: startedAt,
  status,
});

const mistake = (user, topic, resolved) => ({
  user,
  topic,
  quiz: oid(),
  questionId: oid(),
  questionPrompt: 'Q?',
  correctAnswer: 'A',
  explanation: 'Because.',
  resolved,
});

/**
 * Known dataset for one user (UTC):
 *
 *  Math    : T1 completed, T2 in_progress, T3 not_started
 *  Physics : T4 completed
 *  Lessons : T1 completed 05-12, T2 not completed, T4 completed 05-06 (last week)
 *  Attempts: T1 60 (05-06) and 80 (05-12), T2 40 (05-13), T4 100 (05-05)  -> avg 70
 *  Study   : T1 30 min (05-12), none/T0 20 min (05-13), T4 45.5 min (05-06),
 *            plus an abandoned (0) and a completed-but-other-user session (ignored)
 *  Flashcards reviewed: 3, mistakes: 2 unresolved (T2) + 1 resolved
 *  Tasks done: 05-12, 05-13 (this week), 05-06 (last week); 1 still todo
 *  Streak: current 4, longest 7, last active 05-13
 */
const seedKnownUser = async (user, { streakLast = '2026-05-13T08:00:00Z' } = {}) => {
  const [math, physics] = await Subject.create([
    { user, name: 'Math', color: '#112233' },
    { user, name: 'Physics' },
  ]);
  const [t1, t2, t3, t4] = await Topic.create([
    { user, subject: math._id, title: 'Limits', order: 0, status: 'completed' },
    { user, subject: math._id, title: 'Derivatives', order: 1, status: 'in_progress' },
    { user, subject: math._id, title: 'Integrals', order: 2, status: 'not_started' },
    { user, subject: physics._id, title: 'Kinematics', order: 0, status: 'completed' },
  ]);

  await Lesson.create([
    { user, topic: t1._id, title: 'L1', completed: true, completedAt: d('2026-05-12T10:00:00Z') },
    { user, topic: t2._id, title: 'L2' },
    { user, topic: t4._id, title: 'L4', completed: true, completedAt: d('2026-05-06T10:00:00Z') },
  ]);

  await Attempt.insertMany([
    attempt(user, t1._id, 60, d('2026-05-06T09:00:00Z')),
    attempt(user, t1._id, 80, d('2026-05-12T09:00:00Z')),
    attempt(user, t2._id, 40, d('2026-05-13T09:00:00Z')),
    attempt(user, t4._id, 100, d('2026-05-05T09:00:00Z')),
  ]);

  await StudySession.insertMany([
    session(user, t1._id, 30, d('2026-05-12T09:00:00Z')),
    session(user, null, 20, d('2026-05-13T09:00:00Z')),
    session(user, t4._id, 45.5, d('2026-05-06T09:00:00Z')),
    session(user, t1._id, 0, d('2026-05-12T20:00:00Z'), 'abandoned'),
  ]);

  await ActivityLog.insertMany(
    Array.from({ length: 3 }, (_, i) => ({
      user,
      type: 'flashcard_reviewed',
      createdAt: d(`2026-05-1${i}T10:00:00Z`),
    })),
  );

  await Mistake.insertMany([
    mistake(user, t2._id, false),
    mistake(user, t2._id, false),
    mistake(user, t2._id, true),
  ]);

  await Task.insertMany([
    { user, title: 'a', status: 'done', completedAt: d('2026-05-12T10:00:00Z') },
    { user, title: 'b', status: 'done', completedAt: d('2026-05-13T10:00:00Z') },
    { user, title: 'c', status: 'done', completedAt: d('2026-05-06T10:00:00Z') },
    { user, title: 'd', status: 'todo' },
  ]);

  await User.updateOne(
    { _id: user },
    { $set: { streak: { current: 4, longest: 7, lastActiveDate: d(streakLast) } } },
  );

  return { math, physics, t1, t2, t3, t4 };
};

const newUser = async (email) => {
  const { id, token } = await registerUser(email);
  return { id: new mongoose.Types.ObjectId(id), token, idString: id };
};

/* ---------------------------------- Pure ---------------------------------- */

describe('calculateTrend', () => {
  it('is improving when the newer half beats the older half by 5+ points', () => {
    expect(calculateTrend([50, 55, 70, 80])).toMatchObject({
      trend: 'improving',
      previousAverage: 52.5,
      recentAverage: 75,
      change: 22.5,
      sampleSize: 4,
    });
  });

  it('is declining when the newer half trails by 5+ points', () => {
    expect(calculateTrend([90, 85, 60, 55]).trend).toBe('declining');
  });

  it('is stable for small movements, including exactly under the threshold', () => {
    expect(calculateTrend([70, 72, 71, 73]).trend).toBe('stable');
    expect(calculateTrend([70, 70, 74, 74]).trend).toBe('stable');
    // Exactly 5 points counts.
    expect(calculateTrend([70, 70, 75, 75]).trend).toBe('improving');
    expect(calculateTrend([75, 75, 70, 70]).trend).toBe('declining');
  });

  it('is stable (without averages) when there are too few attempts', () => {
    expect(calculateTrend([])).toMatchObject({ trend: 'stable', sampleSize: 0, change: null });
    expect(calculateTrend([10, 90, 100])).toMatchObject({
      trend: 'stable',
      sampleSize: 3,
      recentAverage: null,
    });
  });

  it('only looks at the 10 most recent attempts and ignores the middle one of an odd count', () => {
    // Old low scores are outside the window, so the visible history is flat.
    const flat = [0, 0, 0, 0, 80, 80, 80, 80, 80, 80, 80, 80, 80, 80];
    expect(calculateTrend(flat)).toMatchObject({ trend: 'stable', sampleSize: 10 });

    // 5 attempts: [50, 50] vs [90, 90]; the middle 0 is ignored.
    expect(calculateTrend([50, 50, 0, 90, 90])).toMatchObject({
      trend: 'improving',
      previousAverage: 50,
      recentAverage: 90,
    });
  });
});

describe('percentChange', () => {
  it('computes the change in percent', () => {
    expect(percentChange(150, 100)).toBe(50);
    expect(percentChange(50, 100)).toBe(-50);
    expect(percentChange(100, 100)).toBe(0);
    expect(percentChange(100, 3)).toBe(3233.3);
  });

  it('is null without a baseline', () => {
    expect(percentChange(5, 0)).toBeNull();
    expect(percentChange(5, null)).toBeNull();
    expect(percentChange(null, 5)).toBeNull();
    expect(percentChange(0, 0)).toBe(0);
  });
});

describe('describeActivity', () => {
  it.each([
    ['lesson_opened', { format: 'steps' }, 'Opened a lesson (step-by-step format)'],
    ['lesson_opened', {}, 'Opened a lesson'],
    ['lesson_completed', {}, 'Completed a lesson'],
    ['quiz_submitted', { percentage: 83.33 }, 'Submitted a quiz (scored 83.3%)'],
    ['quiz_submitted', null, 'Submitted a quiz'],
    ['flashcard_reviewed', { rating: 'easy' }, 'Reviewed a flashcard (easy)'],
    ['session_started', {}, 'Started a study session'],
    ['session_finished', { durationMinutes: 25 }, 'Finished a study session (25 min)'],
    ['task_completed', {}, 'Completed a task'],
    ['onboarding_completed', {}, 'Completed onboarding'],
    ['onboarding_completed', { retake: true }, 'Retook the onboarding questionnaire'],
  ])('%s %j -> %s', (type, metadata, label) => {
    expect(describeActivity(type, metadata)).toBe(label);
  });
});

/* -------------------------------- Auth / shape ---------------------------- */

describe('progress auth', () => {
  it.each([
    '/progress/summary',
    '/progress/subjects',
    '/progress/subjects/64b000000000000000000001',
    '/progress/quizzes',
    '/progress/activity',
    '/progress/heatmap',
    '/progress/weekly-report',
  ])('GET %s requires authentication', async (path) => {
    const res = await request(app).get(`${API}${path}`);
    expect(res.status).toBe(401);
  });
});

/* --------------------------------- Summary -------------------------------- */

describe('GET /progress/summary', () => {
  it('matches the known seeded dataset', async () => {
    const { id } = await newUser('ada@example.com');
    await seedKnownUser(id);

    expect(await getSummary(id, { now: NOW })).toEqual({
      timezone: 'UTC',
      week: { start: d('2026-05-11T00:00:00Z'), end: d('2026-05-18T00:00:00Z') },
      lessons: { completed: 2, total: 3, percentage: 67 },
      topics: { completed: 2, total: 4, percentage: 50 },
      quizzes: { taken: 4, averageScore: 70 },
      studyMinutes: { thisWeek: 50, allTime: 95.5 },
      streak: { current: 4, longest: 7, lastActiveDate: d('2026-05-13T08:00:00Z') },
      flashcardsReviewed: 3,
      unresolvedMistakes: 2,
      tasksCompletedThisWeek: 2,
    });
  });

  it('returns the all-time numbers through the API', async () => {
    const { id, token } = await newUser('ada@example.com');
    await seedKnownUser(id);

    const res = await get(token, '/progress/summary');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      lessons: { completed: 2, total: 3 },
      topics: { completed: 2, total: 4 },
      quizzes: { taken: 4, averageScore: 70 },
      studyMinutes: { allTime: 95.5 },
      flashcardsReviewed: 3,
      unresolvedMistakes: 2,
    });
    expect(res.body.data.studyMinutes).toHaveProperty('thisWeek');
    expect(res.body.data).toHaveProperty('tasksCompletedThisWeek');
  });

  it('is all zeros for a user with no data', async () => {
    const { id } = await newUser('new@example.com');
    expect(await getSummary(id, { now: NOW })).toMatchObject({
      lessons: { completed: 0, total: 0, percentage: 0 },
      topics: { completed: 0, total: 0, percentage: 0 },
      quizzes: { taken: 0, averageScore: null },
      studyMinutes: { thisWeek: 0, allTime: 0 },
      streak: { current: 0, longest: 0, lastActiveDate: null },
      flashcardsReviewed: 0,
      unresolvedMistakes: 0,
      tasksCompletedThisWeek: 0,
    });
  });

  it('shows a broken streak as 0 current while keeping the longest', async () => {
    const { id } = await newUser('ada@example.com');
    await seedKnownUser(id, { streakLast: '2026-05-10T08:00:00Z' });
    const { streak } = await getSummary(id, { now: NOW });
    expect(streak).toMatchObject({ current: 0, longest: 7 });
  });

  it('uses the week of the user timezone', async () => {
    const { id } = await newUser('tokyo@example.com');
    await Profile.create({ user: id, academicLevel: 'other', timezone: 'Asia/Tokyo' });
    // Sunday 2026-05-17 20:00 UTC is Monday 05:00 in Tokyo: a new week there, not in UTC.
    await Task.create({
      user: id,
      title: 't',
      status: 'done',
      completedAt: d('2026-05-17T20:00:00Z'),
    });

    const tokyo = await getSummary(id, { now: d('2026-05-17T21:00:00Z') });
    expect(tokyo.timezone).toBe('Asia/Tokyo');
    expect(tokyo.tasksCompletedThisWeek).toBe(1);

    await Profile.updateOne({ user: id }, { $set: { timezone: null } });
    // Same data, but in UTC the task is on Sunday of the week that has just started... it counts.
    expect((await getSummary(id, { now: d('2026-05-17T21:00:00Z') })).tasksCompletedThisWeek).toBe(
      1,
    );
    // A moment later in UTC it is a new week and the task belongs to the previous one.
    expect((await getSummary(id, { now: d('2026-05-18T01:00:00Z') })).tasksCompletedThisWeek).toBe(
      0,
    );
  });
});

/* --------------------------------- Subjects ------------------------------- */

describe('subject progress', () => {
  it('lists per-subject progress for the known dataset', async () => {
    const { id } = await newUser('ada@example.com');
    const { math, physics } = await seedKnownUser(id);

    const result = await getSubjectsProgress(id, { page: 1, limit: 20 });
    expect(result).toMatchObject({ page: 1, limit: 20, total: 2 });
    expect(result.items).toEqual([
      {
        id: String(math._id),
        name: 'Math',
        color: '#112233',
        icon: null,
        archived: false,
        topics: { completed: 1, total: 3 },
        progressPercentage: 33,
        quizAttempts: 3,
        averageScore: 60,
        studyMinutes: 30,
      },
      {
        id: String(physics._id),
        name: 'Physics',
        color: null,
        icon: null,
        archived: false,
        topics: { completed: 1, total: 1 },
        progressPercentage: 100,
        quizAttempts: 1,
        averageScore: 100,
        studyMinutes: 45.5,
      },
    ]);
  });

  it('GET /progress/subjects paginates and handles a subject without topics', async () => {
    const { id, token } = await newUser('ada@example.com');
    await seedKnownUser(id);
    await Subject.create({ user: id, name: 'Art' });

    const res = await get(token, '/progress/subjects?limit=2&page=1');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ page: 1, limit: 2, total: 3 });
    expect(res.body.data.items.map((s) => s.name)).toEqual(['Art', 'Math']);
    expect(res.body.data.items[0]).toMatchObject({
      progressPercentage: 0,
      averageScore: null,
      quizAttempts: 0,
      studyMinutes: 0,
      topics: { completed: 0, total: 0 },
    });

    const page2 = await get(token, '/progress/subjects?limit=2&page=2');
    expect(page2.body.data.items.map((s) => s.name)).toEqual(['Physics']);
  });

  it('GET /progress/subjects/:id returns topic-level detail', async () => {
    const { id, token } = await newUser('ada@example.com');
    const { math, t1, t2, t3 } = await seedKnownUser(id);

    const res = await get(token, `/progress/subjects/${math._id}`);
    expect(res.status).toBe(200);
    const data = res.body.data;

    expect(data.subject).toMatchObject({ id: String(math._id), name: 'Math' });
    expect(data).toMatchObject({
      topics: { completed: 1, total: 3 },
      progressPercentage: 33,
      quizAttempts: 3,
      averageScore: 60,
      studyMinutes: 30,
      unresolvedMistakes: 2,
    });
    expect(data.items.map((t) => t.title)).toEqual(['Limits', 'Derivatives', 'Integrals']);
    expect(data.items[0]).toMatchObject({
      id: String(t1._id),
      status: 'completed',
      hasLesson: true,
      lessonCompleted: true,
      quizAttempts: 2,
      averageScore: 70,
      bestScore: 80,
      lastScore: 80,
      studyMinutes: 30,
      unresolvedMistakes: 0,
    });
    expect(data.items[1]).toMatchObject({
      id: String(t2._id),
      status: 'in_progress',
      lessonCompleted: false,
      quizAttempts: 1,
      averageScore: 40,
      unresolvedMistakes: 2,
    });
    expect(data.items[2]).toMatchObject({
      id: String(t3._id),
      hasLesson: false,
      quizAttempts: 0,
      averageScore: null,
      lastAttemptAt: null,
    });
  });

  it('returns 404 for an unknown subject and 400 for a malformed id', async () => {
    const { token } = await newUser('ada@example.com');
    expect((await get(token, `/progress/subjects/${oid()}`)).status).toBe(404);
    const bad = await get(token, '/progress/subjects/nope');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
  });
});

/* --------------------------------- Quizzes -------------------------------- */

describe('GET /progress/quizzes', () => {
  const seedHistory = async (user, topic, scores, start = '2026-05-01') =>
    Attempt.insertMany(
      scores.map((score, i) =>
        attempt(user, topic, score, new Date(d(`${start}T09:00:00Z`).getTime() + i * 86400000)),
      ),
    );

  it('returns the history newest first with average, best and trend', async () => {
    const { id, token } = await newUser('ada@example.com');
    const subject = await Subject.create({ user: id, name: 'Math' });
    const topic = await Topic.create({ user: id, subject: subject._id, title: 'T' });
    await seedHistory(id, topic._id, [40, 50, 70, 90]);

    const res = await get(token, '/progress/quizzes');
    expect(res.status).toBe(200);
    const data = res.body.data;

    expect(data).toMatchObject({
      page: 1,
      limit: 20,
      total: 4,
      averageScore: 62.5,
      bestScore: 90,
      trend: 'improving',
      trendDetails: { sampleSize: 4, previousAverage: 45, recentAverage: 80, change: 35 },
    });
    expect(data.items.map((a) => a.percentage)).toEqual([90, 70, 50, 40]);
    expect(data.items[0]).toMatchObject({
      topicId: String(topic._id),
      score: 90,
      maxScore: 100,
      durationSeconds: 60,
    });
  });

  it('detects a declining and a stable trend', async () => {
    const { id, token } = await newUser('ada@example.com');
    const subject = await Subject.create({ user: id, name: 'Math' });
    const down = await Topic.create({ user: id, subject: subject._id, title: 'Down' });
    const flat = await Topic.create({ user: id, subject: subject._id, title: 'Flat' });
    await seedHistory(id, down._id, [95, 90, 60, 50]);
    await seedHistory(id, flat._id, [70, 72, 71, 70], '2026-06-01');

    expect((await get(token, `/progress/quizzes?topic=${down._id}`)).body.data.trend).toBe(
      'declining',
    );
    expect((await get(token, `/progress/quizzes?topic=${flat._id}`)).body.data.trend).toBe(
      'stable',
    );
  });

  it('computes the trend over the whole range, not only the requested page', async () => {
    const { id, token } = await newUser('ada@example.com');
    const subject = await Subject.create({ user: id, name: 'Math' });
    const topic = await Topic.create({ user: id, subject: subject._id, title: 'T' });
    await seedHistory(id, topic._id, [30, 40, 80, 90]);

    const res = await get(token, '/progress/quizzes?limit=1&page=2');
    expect(res.body.data).toMatchObject({ total: 4, trend: 'improving', limit: 1, page: 2 });
    expect(res.body.data.items.map((a) => a.percentage)).toEqual([80]);
  });

  it('filters by topic', async () => {
    const { id, token } = await newUser('ada@example.com');
    const subject = await Subject.create({ user: id, name: 'Math' });
    const a = await Topic.create({ user: id, subject: subject._id, title: 'A' });
    const b = await Topic.create({ user: id, subject: subject._id, title: 'B' });
    await seedHistory(id, a._id, [10, 20]);
    await seedHistory(id, b._id, [90]);

    const res = await get(token, `/progress/quizzes?topic=${b._id}`);
    expect(res.body.data.total).toBe(1);
    expect(res.body.data.items[0].percentage).toBe(90);
    expect(res.body.data.averageScore).toBe(90);
  });

  describe('date range filtering', () => {
    let token;
    beforeEach(async () => {
      const user = await newUser('ada@example.com');
      token = user.token;
      const subject = await Subject.create({ user: user.id, name: 'Math' });
      const topic = await Topic.create({ user: user.id, subject: subject._id, title: 'T' });
      // One attempt per day at 09:00 UTC: May 1 (10) .. May 6 (60).
      await seedHistory(user.id, topic._id, [10, 20, 30, 40, 50, 60]);
    });

    const percentages = (res) => res.body.data.items.map((a) => a.percentage);

    it('from is inclusive', async () => {
      const res = await get(token, '/progress/quizzes?from=2026-05-04');
      expect(percentages(res)).toEqual([60, 50, 40]);
    });

    it('a date-only to includes that whole day', async () => {
      const res = await get(token, '/progress/quizzes?to=2026-05-02');
      expect(percentages(res)).toEqual([20, 10]);
    });

    it('from and to together select a window, and the stats follow it', async () => {
      const res = await get(token, '/progress/quizzes?from=2026-05-03&to=2026-05-05');
      expect(percentages(res)).toEqual([50, 40, 30]);
      expect(res.body.data).toMatchObject({ total: 3, averageScore: 40, bestScore: 50 });
    });

    it('accepts date-times with an offset, to being exact', async () => {
      const res = await get(
        token,
        `/progress/quizzes?from=${encodeURIComponent('2026-05-03T09:00:00Z')}&to=${encodeURIComponent('2026-05-04T08:59:59Z')}`,
      );
      expect(percentages(res)).toEqual([30]);
    });

    it('returns an empty history for an empty window', async () => {
      const res = await get(token, '/progress/quizzes?from=2027-01-01');
      expect(res.body.data).toMatchObject({
        total: 0,
        items: [],
        averageScore: null,
        bestScore: null,
        trend: 'stable',
      });
    });

    it.each([
      ['from after to', '?from=2026-05-05&to=2026-05-01'],
      ['invalid date', '?from=yesterday'],
      ['bad topic id', '?topic=nope'],
      ['bad limit', '?limit=0'],
    ])('rejects %s', async (_name, query) => {
      const res = await get(token, `/progress/quizzes${query}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });
});

/* --------------------------------- Activity ------------------------------- */

describe('GET /progress/activity', () => {
  const seed = async (user) =>
    ActivityLog.insertMany([
      { user, type: 'lesson_completed', createdAt: d('2026-05-01T10:00:00Z') },
      {
        user,
        type: 'quiz_submitted',
        metadata: { percentage: 90 },
        createdAt: d('2026-05-02T10:00:00Z'),
      },
      {
        user,
        type: 'flashcard_reviewed',
        metadata: { rating: 'hard' },
        createdAt: d('2026-05-03T10:00:00Z'),
      },
      {
        user,
        type: 'session_finished',
        metadata: { durationMinutes: 25 },
        createdAt: d('2026-05-04T10:00:00Z'),
      },
    ]);

  it('returns a paginated timeline, newest first, with readable labels', async () => {
    const { id, token } = await newUser('ada@example.com');
    await seed(id);

    const res = await get(token, '/progress/activity?limit=3');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ page: 1, limit: 3, total: 4 });
    expect(res.body.data.items.map((e) => e.label)).toEqual([
      'Finished a study session (25 min)',
      'Reviewed a flashcard (hard)',
      'Submitted a quiz (scored 90%)',
    ]);
    expect(res.body.data.items[0]).toMatchObject({
      type: 'session_finished',
      metadata: { durationMinutes: 25 },
      createdAt: '2026-05-04T10:00:00.000Z',
    });

    const page2 = await get(token, '/progress/activity?limit=3&page=2');
    expect(page2.body.data.items.map((e) => e.label)).toEqual(['Completed a lesson']);
  });

  it('filters by one type, several types and a date range', async () => {
    const { id, token } = await newUser('ada@example.com');
    await seed(id);

    const one = await get(token, '/progress/activity?type=quiz_submitted');
    expect(one.body.data.items.map((e) => e.type)).toEqual(['quiz_submitted']);

    const many = await get(token, '/progress/activity?type=lesson_completed,session_finished');
    expect(many.body.data.items.map((e) => e.type)).toEqual([
      'session_finished',
      'lesson_completed',
    ]);

    const range = await get(token, '/progress/activity?from=2026-05-02&to=2026-05-03');
    expect(range.body.data.items.map((e) => e.type)).toEqual([
      'flashcard_reviewed',
      'quiz_submitted',
    ]);

    const combined = await get(
      token,
      '/progress/activity?from=2026-05-02&to=2026-05-03&type=quiz_submitted',
    );
    expect(combined.body.data.total).toBe(1);
  });

  it('rejects an unknown type and a reversed range', async () => {
    const { token } = await newUser('ada@example.com');
    expect((await get(token, '/progress/activity?type=nap_time')).status).toBe(400);
    expect((await get(token, '/progress/activity?type=quiz_submitted,nope')).status).toBe(400);
    expect((await get(token, '/progress/activity?from=2026-05-05&to=2026-05-01')).status).toBe(400);
  });
});

/* --------------------------------- Heatmap -------------------------------- */

describe('heatmap', () => {
  const at = (iso, user, type = 'lesson_opened') => ({ user, type, createdAt: d(iso) });

  it('returns a gapless daily series with counts and levels', async () => {
    const { id } = await newUser('ada@example.com');
    const other = oid();
    await ActivityLog.insertMany([
      at('2026-05-13T08:00:00Z', id),
      at('2026-05-13T09:00:00Z', id, 'quiz_submitted'),
      at('2026-05-13T11:00:00Z', id),
      at('2026-05-12T23:59:59Z', id),
      at('2026-05-07T00:00:00Z', id),
      at('2026-05-07T18:00:00Z', id),
      // Outside the 7-day window, or someone else's.
      at('2026-05-06T23:59:59Z', id),
      at('2026-05-13T10:00:00Z', other),
    ]);

    const result = await getHeatmap(id, { days: 7 }, { now: NOW });

    expect(result).toMatchObject({
      days: 7,
      timezone: 'UTC',
      from: '2026-05-07',
      to: '2026-05-13',
      totalActivities: 6,
      activeDays: 3,
      maxCount: 3,
    });
    expect(result.items).toEqual([
      { date: '2026-05-07', count: 2, level: 3 },
      { date: '2026-05-08', count: 0, level: 0 },
      { date: '2026-05-09', count: 0, level: 0 },
      { date: '2026-05-10', count: 0, level: 0 },
      { date: '2026-05-11', count: 0, level: 0 },
      { date: '2026-05-12', count: 1, level: 2 },
      { date: '2026-05-13', count: 3, level: 4 },
    ]);
  });

  it('groups days in the user timezone', async () => {
    const { id } = await newUser('tokyo@example.com');
    await Profile.create({ user: id, academicLevel: 'other', timezone: 'Asia/Tokyo' });
    // 20:00 UTC on the 13th is 05:00 on the 14th in Tokyo.
    await ActivityLog.insertMany([
      at('2026-05-13T20:00:00Z', id),
      at('2026-05-13T10:00:00Z', id), // 19:00 on the 13th in Tokyo
    ]);

    const result = await getHeatmap(id, { days: 2 }, { now: d('2026-05-13T21:00:00Z') });
    expect(result).toMatchObject({ timezone: 'Asia/Tokyo', from: '2026-05-13', to: '2026-05-14' });
    expect(result.items.map((i) => [i.date, i.count])).toEqual([
      ['2026-05-13', 1],
      ['2026-05-14', 1],
    ]);
  });

  it('is all zeros without activity', async () => {
    const { id } = await newUser('ada@example.com');
    const result = await getHeatmap(id, { days: 3 }, { now: NOW });
    expect(result).toMatchObject({ totalActivities: 0, activeDays: 0, maxCount: 0 });
    expect(result.items.every((i) => i.count === 0 && i.level === 0)).toBe(true);
  });

  it('GET /progress/heatmap defaults to 90 days and counts today', async () => {
    const { id, token } = await newUser('ada@example.com');
    await ActivityLog.create({ user: id, type: 'lesson_opened' });

    const res = await get(token, '/progress/heatmap');
    expect(res.status).toBe(200);
    expect(res.body.data.days).toBe(90);
    expect(res.body.data.items).toHaveLength(90);
    expect(res.body.data.items.at(-1)).toMatchObject({ count: 1, level: 4 });
    expect(res.body.data.items.at(-1).date).toBe(res.body.data.to);

    const short = await get(token, '/progress/heatmap?days=7');
    expect(short.body.data.items).toHaveLength(7);
  });

  it.each([['0'], ['366'], ['abc'], ['1.5']])('rejects days=%s', async (days) => {
    const { token } = await newUser('ada@example.com');
    const res = await get(token, `/progress/heatmap?days=${days}`);
    expect(res.status).toBe(400);
  });
});

/* ------------------------------ Weekly report ----------------------------- */

describe('weekly report', () => {
  it('compares this week with last week', async () => {
    const { id } = await newUser('ada@example.com');
    const topic = oid();
    await Attempt.insertMany([
      attempt(id, topic, 80, d('2026-05-12T09:00:00Z')),
      attempt(id, topic, 60, d('2026-05-13T09:00:00Z')),
      attempt(id, topic, 50, d('2026-05-06T09:00:00Z')),
      // Outside both weeks.
      attempt(id, topic, 5, d('2026-04-28T09:00:00Z')),
    ]);
    await StudySession.insertMany([
      session(id, topic, 40, d('2026-05-11T09:00:00Z')),
      session(id, topic, 20, d('2026-05-13T09:00:00Z')),
      session(id, topic, 40, d('2026-05-05T09:00:00Z')),
      session(id, topic, 99, d('2026-05-12T09:00:00Z'), 'abandoned'),
    ]);
    await Lesson.create([
      {
        user: id,
        topic: oid(),
        title: 'a',
        completed: true,
        completedAt: d('2026-05-05T10:00:00Z'),
      },
      {
        user: id,
        topic: oid(),
        title: 'b',
        completed: true,
        completedAt: d('2026-05-09T10:00:00Z'),
      },
    ]);

    const report = await getWeeklyReport(id, { now: NOW });

    expect(report.thisWeek).toEqual({
      start: d('2026-05-11T00:00:00Z'),
      end: d('2026-05-18T00:00:00Z'),
      studyMinutes: 60,
      quizzes: 2,
      averageScore: 70,
      lessonsCompleted: 0,
    });
    expect(report.lastWeek).toEqual({
      start: d('2026-05-04T00:00:00Z'),
      end: d('2026-05-11T00:00:00Z'),
      studyMinutes: 40,
      quizzes: 1,
      averageScore: 50,
      lessonsCompleted: 2,
    });
    expect(report.change).toEqual({
      studyMinutes: 50,
      quizzes: 100,
      averageScore: 40,
      lessonsCompleted: -100,
    });
    expect(report.difference).toEqual({
      studyMinutes: 20,
      quizzes: 1,
      averageScore: 20,
      lessonsCompleted: -2,
    });
  });

  it('uses null when last week has no baseline', async () => {
    const { id } = await newUser('ada@example.com');
    await Attempt.create(attempt(id, oid(), 90, d('2026-05-12T09:00:00Z')));

    const report = await getWeeklyReport(id, { now: NOW });
    expect(report.change).toEqual({
      studyMinutes: 0,
      quizzes: null,
      averageScore: null,
      lessonsCompleted: 0,
    });
    expect(report.lastWeek).toMatchObject({ quizzes: 0, averageScore: null, studyMinutes: 0 });
    expect(report.difference.averageScore).toBeNull();
  });

  it('puts the week boundary at midnight of the user timezone', async () => {
    const { id } = await newUser('tokyo@example.com');
    await Profile.create({ user: id, academicLevel: 'other', timezone: 'Asia/Tokyo' });
    // Sunday 20:00 UTC = Monday 05:00 in Tokyo: this week there, last week in UTC.
    await Attempt.create(attempt(id, oid(), 70, d('2026-05-17T20:00:00Z')));

    const tokyo = await getWeeklyReport(id, { now: d('2026-05-17T21:00:00Z') });
    expect(tokyo.timezone).toBe('Asia/Tokyo');
    expect(tokyo.thisWeek.quizzes).toBe(1);
    expect(tokyo.lastWeek.quizzes).toBe(0);

    await Profile.updateOne({ user: id }, { $set: { timezone: null } });
    const utc = await getWeeklyReport(id, { now: d('2026-05-17T21:00:00Z') });
    expect(utc.thisWeek.quizzes).toBe(1);
  });

  it('GET /progress/weekly-report returns the report', async () => {
    const { token } = await newUser('ada@example.com');
    const res = await get(token, '/progress/weekly-report');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      timezone: 'UTC',
      thisWeek: { quizzes: 0, studyMinutes: 0, lessonsCompleted: 0, averageScore: null },
      lastWeek: { quizzes: 0 },
      change: { quizzes: 0 },
    });
  });
});

/* ------------------------------ Ownership ------------------------------- */

describe('ownership isolation', () => {
  it("never mixes in or reveals another user's data", async () => {
    const a = await newUser('a@example.com');
    const b = await newUser('b@example.com');
    const seeded = await seedKnownUser(a.id);

    // B has one tiny dataset of their own.
    const bSubject = await Subject.create({ user: b.id, name: 'Chemistry' });
    const bTopic = await Topic.create({ user: b.id, subject: bSubject._id, title: 'Bonds' });
    await Attempt.create(attempt(b.id, bTopic._id, 33, d('2026-05-12T09:00:00Z')));
    await ActivityLog.create({ user: b.id, type: 'lesson_opened' });

    const summary = (await get(b.token, '/progress/summary')).body.data;
    expect(summary).toMatchObject({
      lessons: { completed: 0, total: 0 },
      topics: { total: 1 },
      quizzes: { taken: 1, averageScore: 33 },
      studyMinutes: { allTime: 0 },
      flashcardsReviewed: 0,
      unresolvedMistakes: 0,
      streak: { longest: 0 },
    });

    const subjects = (await get(b.token, '/progress/subjects')).body.data;
    expect(subjects.items.map((s) => s.name)).toEqual(['Chemistry']);

    const quizzes = (await get(b.token, '/progress/quizzes')).body.data;
    expect(quizzes.items.map((i) => i.percentage)).toEqual([33]);

    const activity = (await get(b.token, '/progress/activity')).body.data;
    expect(activity.total).toBe(1);

    // A's ids answer 404, exactly like ids that do not exist.
    const subjectRes = await get(b.token, `/progress/subjects/${seeded.math._id}`);
    expect(subjectRes.status).toBe(404);
    expect(JSON.stringify(subjectRes.body)).not.toContain('Math');
    expect((await get(b.token, `/progress/quizzes?topic=${seeded.t1._id}`)).status).toBe(404);

    // And A still sees their own numbers untouched.
    const aSummary = (await get(a.token, '/progress/summary')).body.data;
    expect(aSummary.quizzes).toEqual({ taken: 4, averageScore: 70 });
    expect((await get(a.token, `/progress/subjects/${seeded.math._id}`)).status).toBe(200);
  });
});
