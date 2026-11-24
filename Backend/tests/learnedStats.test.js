import mongoose from 'mongoose';
import request from 'supertest';
import app from '../src/app.js';
import { Profile } from '../src/modules/profile/profile.model.js';
import { Subject, Topic } from '../src/modules/space/space.model.js';
import { Attempt } from '../src/modules/practice/practice.model.js';
import { Mistake } from '../src/modules/mistakes/mistakes.model.js';
import { ActivityLog } from '../src/modules/activity-log/activity-log.model.js';
import {
  buildSummary,
  pickDominantFormat,
  recomputeLearnedStats,
  timeOfDayForHour,
} from '../src/modules/profile/profile.service.js';
import { startTestDb, clearTestDb, stopTestDb } from './helpers/db.js';
import { API, validOnboarding, registerUser, bearer } from './helpers/auth.js';

const oid = () => new mongoose.Types.ObjectId();
const d = (iso) => new Date(iso);

beforeAll(async () => {
  await startTestDb();
}, 120000);

afterEach(async () => {
  await clearTestDb();
});

afterAll(async () => {
  await stopTestDb();
});

const makeProfile = (user, extra = {}) =>
  Profile.create({ user, academicLevel: 'other', ...extra });

const attempt = (user, topic, percentage) => ({
  user,
  quiz: oid(),
  topic,
  score: percentage,
  maxScore: 100,
  percentage,
});

const mistake = (user, topic) => ({
  user,
  topic,
  quiz: oid(),
  questionId: oid(),
  questionPrompt: 'Q?',
  correctAnswer: 'A',
  explanation: 'Because.',
});

const opened = (user, format, iso) => ({
  user,
  type: 'lesson_opened',
  metadata: { format },
  createdAt: d(iso),
});

describe('pure helpers', () => {
  it('pickDominantFormat returns the most used format, earliest on ties, null when unused', () => {
    expect(pickDominantFormat({ simplified: 1, diagram: 5, steps: 2, examples: 0 })).toBe(
      'diagram',
    );
    expect(pickDominantFormat({ simplified: 0, diagram: 0, steps: 3, examples: 3 })).toBe('steps');
    expect(pickDominantFormat({ simplified: 0, diagram: 0, steps: 0, examples: 0 })).toBeNull();
    expect(pickDominantFormat(undefined)).toBeNull();
  });

  it.each([
    [0, 'night'],
    [4, 'night'],
    [5, 'morning'],
    [11, 'morning'],
    [12, 'afternoon'],
    [16, 'afternoon'],
    [17, 'evening'],
    [21, 'evening'],
    [22, 'night'],
    [23, 'night'],
  ])('timeOfDayForHour(%i) is %s', (hour, expected) => {
    expect(timeOfDayForHour(hour)).toBe(expected);
  });

  it.each([[null], [-1], [24], [1.5], [undefined]])('timeOfDayForHour(%p) is null', (hour) => {
    expect(timeOfDayForHour(hour)).toBeNull();
  });

  it('buildSummary adds learned clauses only when there is data', () => {
    const base = { preferredFormats: ['visual'], studyHabits: { bestTimeOfDay: 'evening' } };
    expect(buildSummary({ ...base, learnedStats: {} })).toBe(
      'Visual learner, studies best in the evening',
    );

    const text = buildSummary(
      {
        ...base,
        learnedStats: {
          dominantFormat: 'steps',
          recommendedBestTime: 'morning',
          avgSessionMinutes: 32.5,
        },
      },
      { weakTopicTitles: ['Limits', 'Integrals'] },
    );
    expect(text).toBe(
      'Visual learner, studies best in the evening, mostly opens step-by-step lessons, is actually most active in the morning, averages 32.5-minute sessions, needs practice on: Limits, Integrals',
    );

    // Same time of day as declared: nothing new to say.
    expect(
      buildSummary({ ...base, learnedStats: { recommendedBestTime: 'evening' } }),
    ).not.toContain('actually');
  });
});

describe('recomputeLearnedStats output', () => {
  it('derives every learned field from the activity of the user', async () => {
    const user = oid();
    await makeProfile(user);
    const sessionA = oid();

    await ActivityLog.insertMany([
      opened(user, 'steps', '2026-05-01T19:10:00Z'),
      opened(user, 'steps', '2026-05-02T19:40:00Z'),
      opened(user, 'diagram', '2026-05-03T19:20:00Z'),
      { user, type: 'session_started', refId: sessionA, createdAt: d('2026-05-04T19:00:00Z') },
      {
        user,
        type: 'session_finished',
        refId: sessionA,
        metadata: { durationMinutes: 40 },
        createdAt: d('2026-05-04T19:40:00Z'),
      },
      { user, type: 'quiz_submitted', createdAt: d('2026-05-05T08:00:00Z') },
      { user: oid(), ...opened(oid(), 'examples', '2026-05-05T08:00:00Z') },
    ]);

    const { learnedStats: stats } = await recomputeLearnedStats(user);
    expect(stats.formatUsage.toObject()).toEqual({
      simplified: 0,
      diagram: 1,
      steps: 2,
      examples: 0,
    });
    expect(stats.dominantFormat).toBe('steps');
    expect(stats.avgSessionMinutes).toBe(40);
    // 5 events at 19:xx UTC (3 lessons opened, session start and finish) vs 1 at 08:00.
    // The other user's event does not count.
    expect(stats.mostActiveHour).toBe(19);
    expect(stats.recommendedBestTime).toBe('evening');
    expect(stats.weakTopics).toEqual([]);
    expect(stats.lastComputedAt).toBeInstanceOf(Date);
  });

  it('reads the most active hour in the timezone of the user', async () => {
    const user = oid();
    await makeProfile(user, { timezone: 'Asia/Tokyo' });
    // 20:00 UTC is 05:00 the next morning in Tokyo.
    await ActivityLog.insertMany([
      opened(user, 'steps', '2026-05-01T20:00:00Z'),
      opened(user, 'steps', '2026-05-02T20:30:00Z'),
    ]);

    const { learnedStats: stats } = await recomputeLearnedStats(user);
    expect(stats.mostActiveHour).toBe(5);
    expect(stats.recommendedBestTime).toBe('morning');
  });

  it('has null derived fields without activity', async () => {
    const user = oid();
    await makeProfile(user);
    const { learnedStats: stats } = await recomputeLearnedStats(user);
    expect(stats.dominantFormat).toBeNull();
    expect(stats.recommendedBestTime).toBeNull();
    expect(stats.mostActiveHour).toBeNull();
  });

  describe('weakTopics', () => {
    it('combines unresolved mistakes with low quiz averages over 2+ attempts', async () => {
      const user = oid();
      await makeProfile(user);
      const [withMistakes, lowAvg, okAvg, singleLow, boundary] = [
        oid(),
        oid(),
        oid(),
        oid(),
        oid(),
      ];

      await Mistake.insertMany([mistake(user, withMistakes)]);
      await Attempt.insertMany([
        attempt(user, lowAvg, 50),
        attempt(user, lowAvg, 40), // average 45 -> weak
        attempt(user, okAvg, 55),
        attempt(user, okAvg, 75), // average 65 -> fine
        attempt(user, singleLow, 5), // one attempt is not enough
        attempt(user, boundary, 50),
        attempt(user, boundary, 70), // average exactly 60 -> not below 60
        // Another user's bad scores never leak in.
        attempt(oid(), oid(), 0),
        attempt(oid(), oid(), 0),
      ]);

      const { learnedStats } = await recomputeLearnedStats(user);
      expect(learnedStats.weakTopics.map(String)).toEqual([String(withMistakes), String(lowAvg)]);
    });

    it('lists a topic once when it has both mistakes and low scores, and orders low averages worst first', async () => {
      const user = oid();
      await makeProfile(user);
      const [both, worse, bad] = [oid(), oid(), oid()];

      await Mistake.insertMany([mistake(user, both)]);
      await Attempt.insertMany([
        attempt(user, both, 10),
        attempt(user, both, 20),
        attempt(user, bad, 50),
        attempt(user, bad, 50),
        attempt(user, worse, 20),
        attempt(user, worse, 30),
      ]);

      const { learnedStats } = await recomputeLearnedStats(user);
      expect(learnedStats.weakTopics.map(String)).toEqual([
        String(both),
        String(worse),
        String(bad),
      ]);
    });

    it('does not count resolved mistakes', async () => {
      const user = oid();
      await makeProfile(user);
      const topic = oid();
      await Mistake.insertMany([{ ...mistake(user, topic), resolved: true }]);

      const { learnedStats } = await recomputeLearnedStats(user);
      expect(learnedStats.weakTopics).toEqual([]);
    });
  });

  describe('debounce', () => {
    const FIVE_MIN = 5 * 60 * 1000;

    it('computes at most once per window unless forced', async () => {
      const user = oid();
      await makeProfile(user);
      const t0 = d('2026-05-13T10:00:00Z');

      await ActivityLog.create(opened(user, 'steps', '2026-05-13T09:00:00Z'));
      const first = await recomputeLearnedStats(user, { minIntervalMs: FIVE_MIN, now: t0 });
      expect(first.learnedStats.formatUsage.steps).toBe(1);
      expect(first.learnedStats.lastComputedAt).toEqual(t0);

      // New event, 2 minutes later: inside the window, so the stored stats are returned as is.
      await ActivityLog.create(opened(user, 'steps', '2026-05-13T10:01:00Z'));
      const skipped = await recomputeLearnedStats(user, {
        minIntervalMs: FIVE_MIN,
        now: d('2026-05-13T10:02:00Z'),
      });
      expect(skipped.learnedStats.formatUsage.steps).toBe(1);
      expect(skipped.learnedStats.lastComputedAt).toEqual(t0);

      // Forced: ignores the window.
      const forced = await recomputeLearnedStats(user, {
        force: true,
        minIntervalMs: FIVE_MIN,
        now: d('2026-05-13T10:03:00Z'),
      });
      expect(forced.learnedStats.formatUsage.steps).toBe(2);
      expect(forced.learnedStats.lastComputedAt).toEqual(d('2026-05-13T10:03:00Z'));
    });

    it('recomputes again once the window has passed', async () => {
      const user = oid();
      await makeProfile(user);
      await recomputeLearnedStats(user, {
        minIntervalMs: FIVE_MIN,
        now: d('2026-05-13T10:00:00Z'),
      });
      await ActivityLog.create(opened(user, 'diagram', '2026-05-13T10:01:00Z'));

      const later = await recomputeLearnedStats(user, {
        minIntervalMs: FIVE_MIN,
        now: d('2026-05-13T10:05:00Z'),
      });
      expect(later.learnedStats.formatUsage.diagram).toBe(1);
    });

    it('lets only one of several concurrent callers compute', async () => {
      const user = oid();
      await makeProfile(user);
      await ActivityLog.create(opened(user, 'steps', '2026-05-13T09:00:00Z'));
      const now = d('2026-05-13T10:00:00Z');

      const spy = countAggregations();
      await Promise.all(
        Array.from({ length: 5 }, () =>
          recomputeLearnedStats(user, { minIntervalMs: FIVE_MIN, now }),
        ),
      );
      // formatUsage and mostActiveHour each run one aggregation on the log per computation.
      expect(spy.count()).toBe(2);
      spy.restore();
    });

    it('returns the stored profile (or null) without computing when skipped', async () => {
      expect(await recomputeLearnedStats(oid(), { minIntervalMs: FIVE_MIN })).toBeNull();
    });
  });
});

/** Counts ActivityLog.aggregate calls. */
function countAggregations() {
  const original = ActivityLog.aggregate;
  let calls = 0;
  ActivityLog.aggregate = function counted(...args) {
    calls += 1;
    return original.apply(this, args);
  };
  return {
    count: () => calls,
    restore: () => {
      ActivityLog.aggregate = original;
    },
  };
}

describe('profile endpoints', () => {
  const onboard = async (email = 'ada@example.com', overrides = {}) => {
    const user = await registerUser(email);
    await request(app)
      .post(`${API}/onboarding`)
      .set(bearer(user.token))
      .send({ ...validOnboarding, ...overrides });
    return user;
  };

  describe('POST /profile/recompute', () => {
    it('requires authentication', async () => {
      expect((await request(app).post(`${API}/profile/recompute`)).status).toBe(401);
    });

    it('returns 404 before onboarding', async () => {
      const { token } = await registerUser();
      const res = await request(app).post(`${API}/profile/recompute`).set(bearer(token));
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PROFILE_NOT_FOUND');
    });

    it('recomputes the stats from the activity log and returns the profile', async () => {
      const { id, token } = await onboard();
      await ActivityLog.insertMany([
        opened(id, 'examples', '2026-05-01T14:00:00Z'),
        opened(id, 'examples', '2026-05-02T14:30:00Z'),
      ]);

      const res = await request(app).post(`${API}/profile/recompute`).set(bearer(token));
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.profile.learnedStats).toMatchObject({
        formatUsage: { simplified: 0, diagram: 0, steps: 0, examples: 2 },
        dominantFormat: 'examples',
        mostActiveHour: 14,
        recommendedBestTime: 'afternoon',
      });
      expect(res.body.data.profile.learnedStats.lastComputedAt).toEqual(expect.any(String));
    });

    it("only recomputes the caller's own profile", async () => {
      const a = await onboard('a@example.com');
      const b = await onboard('b@example.com');
      await ActivityLog.create(opened(a.id, 'steps', '2026-05-01T14:00:00Z'));

      const res = await request(app).post(`${API}/profile/recompute`).set(bearer(b.token));
      expect(res.body.data.profile.learnedStats.formatUsage.steps).toBe(0);
      expect(res.body.data.profile.user).toBe(b.id);
      const untouched = await Profile.findOne({ user: a.id });
      expect(untouched.learnedStats.lastComputedAt).toBeNull();
    });
  });

  describe('GET /profile/summary', () => {
    it('uses the computed learned data', async () => {
      const { id, token } = await onboard('ada@example.com', {
        preferredFormats: ['visual'],
        studyHabits: { bestTimeOfDay: 'evening', preferredSessionMinutes: 45, sessionsPerWeek: 4 },
        difficulties: [],
      });
      const subject = await Subject.create({ user: id, name: 'Math' });
      const weak = await Topic.create({ user: id, subject: subject._id, title: 'Derivatives' });
      await Mistake.create(mistake(new mongoose.Types.ObjectId(id), weak._id));
      await ActivityLog.insertMany([
        opened(id, 'diagram', '2026-05-01T09:00:00Z'),
        opened(id, 'diagram', '2026-05-02T09:30:00Z'),
        {
          user: id,
          type: 'session_finished',
          metadata: { durationMinutes: 30 },
          createdAt: d('2026-05-02T09:40:00Z'),
        },
      ]);

      const res = await request(app).get(`${API}/profile/summary`).set(bearer(token));
      expect(res.status).toBe(200);
      expect(res.body.data.summary).toBe(
        'Visual learner, studies best in the evening, prefers 45-minute sessions, mostly opens diagram lessons, is actually most active in the morning, averages 30-minute sessions, needs practice on: Derivatives',
      );
      expect(res.body.data.learnedStats).toMatchObject({
        dominantFormat: 'diagram',
        recommendedBestTime: 'morning',
        avgSessionMinutes: 30,
        mostActiveHour: 9,
      });
      expect(res.body.data.weakTopics).toEqual([{ id: String(weak._id), title: 'Derivatives' }]);
    });

    it("never names another user's topics", async () => {
      const a = await onboard('a@example.com');
      const b = await onboard('b@example.com');
      const subject = await Subject.create({ user: a.id, name: 'Secret subject' });
      const topic = await Topic.create({ user: a.id, subject: subject._id, title: 'Secret topic' });
      // A weak-topic id of A inside B's profile (it is recomputed away, and topic names are
      // looked up per user anyway) must never put A's topic title in B's summary.
      await Profile.updateOne({ user: b.id }, { $set: { 'learnedStats.weakTopics': [topic._id] } });

      const res = await request(app).get(`${API}/profile/summary`).set(bearer(b.token));
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain('Secret topic');
      expect(res.body.data.weakTopics).toEqual([]);
    });
  });
});
