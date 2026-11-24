import { jest } from '@jest/globals';
import mongoose from 'mongoose';
import { ActivityLog } from '../src/modules/activity-log/activity-log.model.js';
import { Profile } from '../src/modules/profile/profile.model.js';
import { logActivity } from '../src/services/activity.service.js';
import { recomputeLearnedStats } from '../src/modules/profile/profile.service.js';
import { startTestDb, clearTestDb, stopTestDb } from './helpers/db.js';

const newId = () => new mongoose.Types.ObjectId();

beforeAll(async () => {
  await startTestDb();
}, 120000);

afterEach(async () => {
  jest.restoreAllMocks();
  await clearTestDb();
});

afterAll(async () => {
  await stopTestDb();
});

describe('logActivity', () => {
  it('writes an event', async () => {
    const user = newId();
    const refId = newId();
    const saved = await logActivity({
      user,
      type: 'lesson_opened',
      refId,
      refModel: 'Lesson',
      metadata: { format: 'diagram' },
    });

    expect(saved).not.toBeNull();
    const docs = await ActivityLog.find({ user });
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ type: 'lesson_opened', refModel: 'Lesson' });
    expect(String(docs[0].refId)).toBe(String(refId));
    expect(docs[0].metadata).toEqual({ format: 'diagram' });
    expect(docs[0].createdAt).toBeInstanceOf(Date);
  });

  it('swallows validation errors', async () => {
    await expect(logActivity({ user: newId(), type: 'not_a_type' })).resolves.toBeNull();
    await expect(logActivity({ type: 'lesson_opened' })).resolves.toBeNull();
    await expect(logActivity()).resolves.toBeNull();
    expect(await ActivityLog.countDocuments()).toBe(0);
  });

  it('swallows database errors', async () => {
    jest.spyOn(ActivityLog, 'create').mockRejectedValue(new Error('db down'));
    await expect(logActivity({ user: newId(), type: 'lesson_opened' })).resolves.toBeNull();
  });
});

describe('recomputeLearnedStats', () => {
  const makeProfile = (user) =>
    Profile.create({ user, academicLevel: 'other', 'learnedStats.weakTopics': [newId()] });
  const at = (iso) => new Date(iso);

  it('returns null when the user has no profile', async () => {
    expect(await recomputeLearnedStats(newId())).toBeNull();
    expect(await recomputeLearnedStats('not-an-id')).toBeNull();
  });

  it('computes zeros/nulls for a user without activity', async () => {
    const user = newId();
    await makeProfile(user);
    const { learnedStats } = await recomputeLearnedStats(user);

    expect(learnedStats.formatUsage.toObject()).toEqual({
      simplified: 0,
      diagram: 0,
      steps: 0,
      examples: 0,
    });
    expect(learnedStats.avgSessionMinutes).toBeNull();
    expect(learnedStats.mostActiveHour).toBeNull();
    expect(learnedStats.lastComputedAt).toBeInstanceOf(Date);
  });

  it('computes formatUsage, avgSessionMinutes and mostActiveHour', async () => {
    const user = newId();
    const other = newId();
    await makeProfile(user);
    const sessionA = newId();
    const sessionB = newId();

    await ActivityLog.insertMany([
      {
        user,
        type: 'lesson_opened',
        metadata: { format: 'diagram' },
        createdAt: at('2025-01-01T20:10:00Z'),
      },
      {
        user,
        type: 'lesson_opened',
        metadata: { format: 'diagram' },
        createdAt: at('2025-01-02T20:30:00Z'),
      },
      {
        user,
        // Only lesson_opened counts towards formatUsage.
        type: 'lesson_completed',
        metadata: { format: 'steps' },
        createdAt: at('2025-01-02T20:50:00Z'),
      },
      {
        user,
        type: 'lesson_opened',
        metadata: { format: 'unknown' },
        createdAt: at('2025-01-03T09:00:00Z'),
      },
      { user, type: 'lesson_opened', createdAt: at('2025-01-03T09:05:00Z') },
      // session A: derived from started/finished (30 min); session B: explicit duration (60).
      { user, type: 'session_started', refId: sessionA, createdAt: at('2025-01-04T10:00:00Z') },
      { user, type: 'session_finished', refId: sessionA, createdAt: at('2025-01-04T10:30:00Z') },
      {
        user,
        type: 'session_finished',
        refId: sessionB,
        metadata: { durationMinutes: 60 },
        createdAt: at('2025-01-05T15:00:00Z'),
      },
      // Ignored: onboarding is not study activity; other user's events are not ours.
      { user, type: 'onboarding_completed', createdAt: at('2025-01-06T03:00:00Z') },
      { user, type: 'onboarding_completed', createdAt: at('2025-01-06T03:01:00Z') },
      { user, type: 'onboarding_completed', createdAt: at('2025-01-06T03:02:00Z') },
      {
        user: other,
        type: 'lesson_opened',
        metadata: { format: 'examples' },
        createdAt: at('2025-01-06T04:00:00Z'),
      },
      {
        user: other,
        type: 'session_finished',
        metadata: { durationMinutes: 500 },
        createdAt: at('2025-01-06T04:00:00Z'),
      },
    ]);

    const { learnedStats } = await recomputeLearnedStats(user);

    expect(learnedStats.formatUsage.toObject()).toEqual({
      simplified: 0,
      diagram: 2,
      steps: 0,
      examples: 0,
    });
    expect(learnedStats.dominantFormat).toBe('diagram');
    expect(learnedStats.recommendedBestTime).toBe('evening');
    expect(learnedStats.avgSessionMinutes).toBe(45);
    expect(learnedStats.mostActiveHour).toBe(20);
    // weakTopics is derived from unresolved mistakes (none here), so the seeded value is replaced.
    expect(learnedStats.weakTopics).toHaveLength(0);
  });

  it('is idempotent', async () => {
    const user = newId();
    await makeProfile(user);
    await logActivity({ user, type: 'lesson_opened', metadata: { format: 'examples' } });
    await logActivity({ user, type: 'session_finished', metadata: { durationMinutes: 20 } });

    const strip = (p) => {
      const { lastComputedAt, ...rest } = p.learnedStats.toObject();
      return { lastComputedAt, rest: JSON.parse(JSON.stringify(rest)) };
    };
    const first = strip(await recomputeLearnedStats(user));
    const second = strip(await recomputeLearnedStats(user));
    await Promise.all([recomputeLearnedStats(user), recomputeLearnedStats(user)]);
    const third = strip(await Profile.findOne({ user }));

    expect(second.rest).toEqual(first.rest);
    expect(third.rest).toEqual(first.rest);
    expect(first.rest.formatUsage.examples).toBe(1);
    expect(first.rest.avgSessionMinutes).toBe(20);
    expect(second.lastComputedAt.getTime()).toBeGreaterThanOrEqual(first.lastComputedAt.getTime());
  });
});
