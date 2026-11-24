import { jest } from '@jest/globals';
import request from 'supertest';
import app from '../src/app.js';
import { User } from '../src/modules/auth/auth.model.js';
import { Profile } from '../src/modules/profile/profile.model.js';
import { ActivityLog } from '../src/modules/activity-log/activity-log.model.js';
import {
  computeNextStreak,
  getDisplayStreak,
  updateStreak,
  STREAK_ACTIVITY_TYPES,
} from '../src/modules/progress/streak.service.js';
import { logActivity } from '../src/services/activity.service.js';
import { getWeekWindows, normalizeTimeZone, toDayKey } from '../src/utils/timezone.js';
import { startTestDb, clearTestDb, stopTestDb } from './helpers/db.js';
import { API, validOnboarding, registerUser, bearer } from './helpers/auth.js';
import { api, createSubject, createTopic, createLesson } from './helpers/space.js';
import { createCard } from './helpers/practice.js';

const d = (iso) => new Date(iso);

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

describe('computeNextStreak (pure)', () => {
  const streak = (current, longest, last) => ({
    current,
    longest,
    lastActiveDate: last ? d(last) : null,
  });

  it('starts a streak at 1 on the first ever activity', () => {
    const now = d('2026-05-13T08:00:00Z');
    expect(computeNextStreak(streak(0, 0, null), now)).toEqual({
      changed: true,
      current: 1,
      longest: 1,
      lastActiveDate: now,
    });
    // A user document without the streak object at all.
    expect(computeNextStreak(undefined, now)).toMatchObject({ changed: true, current: 1 });
  });

  it('does nothing on the same day, however late', () => {
    const result = computeNextStreak(
      streak(3, 5, '2026-05-13T00:00:01Z'),
      d('2026-05-13T23:59:59Z'),
    );
    expect(result).toMatchObject({ changed: false, current: 3, longest: 5 });
    expect(result.lastActiveDate).toEqual(d('2026-05-13T00:00:01Z'));
  });

  it('increments on the next day, even a few minutes after midnight', () => {
    const result = computeNextStreak(
      streak(3, 5, '2026-05-13T23:59:00Z'),
      d('2026-05-14T00:01:00Z'),
    );
    expect(result).toMatchObject({ changed: true, current: 4, longest: 5 });
    expect(result.lastActiveDate).toEqual(d('2026-05-14T00:01:00Z'));
  });

  it('resets to 1 after a gap of more than one day', () => {
    const result = computeNextStreak(
      streak(9, 9, '2026-05-10T12:00:00Z'),
      d('2026-05-12T12:00:00Z'),
    );
    expect(result).toMatchObject({ changed: true, current: 1, longest: 9 });
  });

  it('resets to 1 after a long gap', () => {
    const result = computeNextStreak(
      streak(2, 4, '2026-01-01T12:00:00Z'),
      d('2026-05-12T12:00:00Z'),
    );
    expect(result).toMatchObject({ current: 1, longest: 4 });
  });

  it('raises longest only when current beats it', () => {
    const tie = computeNextStreak(streak(4, 5, '2026-05-12T10:00:00Z'), d('2026-05-13T10:00:00Z'));
    expect(tie).toMatchObject({ current: 5, longest: 5 });

    const beat = computeNextStreak(streak(5, 5, '2026-05-12T10:00:00Z'), d('2026-05-13T10:00:00Z'));
    expect(beat).toMatchObject({ current: 6, longest: 6 });

    const below = computeNextStreak(
      streak(1, 7, '2026-05-12T10:00:00Z'),
      d('2026-05-13T10:00:00Z'),
    );
    expect(below).toMatchObject({ current: 2, longest: 7 });
  });

  it('ignores an event older than the last active date', () => {
    const result = computeNextStreak(
      streak(3, 5, '2026-05-13T10:00:00Z'),
      d('2026-05-11T10:00:00Z'),
    );
    expect(result).toMatchObject({ changed: false, current: 3, longest: 5 });
  });

  describe('timezones', () => {
    it('uses the user day, not the UTC day', () => {
      // 23:30 and 00:30 UTC are different UTC days but the same evening in New York.
      const last = '2026-05-13T23:30:00Z';
      const now = d('2026-05-14T00:30:00Z');
      expect(computeNextStreak(streak(2, 2, last), now, 'UTC').current).toBe(3);
      expect(computeNextStreak(streak(2, 2, last), now, 'America/New_York')).toMatchObject({
        changed: false,
        current: 2,
      });
    });

    it('counts two events 2 hours apart as consecutive days when midnight falls between', () => {
      // 23:00 and 01:00 in Tokyo (UTC+9).
      const result = computeNextStreak(
        streak(1, 1, '2026-05-13T14:00:00Z'),
        d('2026-05-13T16:00:00Z'),
        'Asia/Tokyo',
      );
      expect(result).toMatchObject({ changed: true, current: 2 });
    });

    it('treats the 23-hour day of a DST change as one day', () => {
      // New York springs forward on 2026-03-08.
      const result = computeNextStreak(
        streak(4, 4, '2026-03-07T23:59:00-05:00'),
        d('2026-03-08T23:59:00-04:00'),
        'America/New_York',
      );
      expect(result).toMatchObject({ changed: true, current: 5 });
    });
  });
});

describe('getDisplayStreak', () => {
  const now = d('2026-05-13T12:00:00Z');

  it('keeps the streak when the last activity was today or yesterday', () => {
    expect(
      getDisplayStreak({ current: 4, longest: 7, lastActiveDate: d('2026-05-13T01:00:00Z') }, now),
    ).toMatchObject({ current: 4, longest: 7, activeToday: true });
    expect(
      getDisplayStreak({ current: 4, longest: 7, lastActiveDate: d('2026-05-12T23:00:00Z') }, now),
    ).toMatchObject({ current: 4, activeToday: false });
  });

  it('shows 0 once a day has been missed, keeping longest', () => {
    expect(
      getDisplayStreak({ current: 4, longest: 7, lastActiveDate: d('2026-05-11T23:00:00Z') }, now),
    ).toMatchObject({ current: 0, longest: 7, activeToday: false });
  });

  it('handles a user who was never active', () => {
    expect(getDisplayStreak({ current: 0, longest: 0, lastActiveDate: null }, now)).toEqual({
      current: 0,
      longest: 0,
      lastActiveDate: null,
      activeToday: false,
    });
  });
});

describe('timezone helpers', () => {
  it('normalizes and rejects timezones', () => {
    expect(normalizeTimeZone('europe/paris')).toBe('Europe/Paris');
    expect(normalizeTimeZone('Mars/Olympus_Mons')).toBeNull();
    expect(normalizeTimeZone('')).toBeNull();
    expect(normalizeTimeZone(42)).toBeNull();
  });

  it('computes Monday-based week windows in the user timezone', () => {
    // Sunday 16:00 UTC is already Monday 01:00 in Tokyo.
    const now = d('2026-05-17T16:00:00Z');
    const utc = getWeekWindows(now, 'UTC');
    expect(utc.thisWeek.start).toEqual(d('2026-05-11T00:00:00Z'));
    expect(utc.thisWeek.end).toEqual(d('2026-05-18T00:00:00Z'));
    expect(utc.lastWeek.start).toEqual(d('2026-05-04T00:00:00Z'));

    const tokyo = getWeekWindows(now, 'Asia/Tokyo');
    expect(tokyo.thisWeek.start).toEqual(d('2026-05-17T15:00:00Z'));
    expect(tokyo.lastWeek.end).toEqual(tokyo.thisWeek.start);
    expect(toDayKey(now, 'Asia/Tokyo')).toBe('2026-05-18');
  });
});

describe('updateStreak (database)', () => {
  const makeUser = (extra = {}) =>
    User.create({
      name: 'Ada',
      email: `u${Math.random()}@example.com`,
      passwordHash: 'x',
      ...extra,
    });
  const streakOf = async (id) => (await User.findById(id).lean()).streak;

  it('follows a full scenario: start, same day, next day, gap, longest', async () => {
    const user = await makeUser();

    expect(await updateStreak(user._id, { now: d('2026-05-10T09:00:00Z') })).toMatchObject({
      current: 1,
      longest: 1,
    });
    // Same day: no change at all (lastActiveDate is not moved either).
    await updateStreak(user._id, { now: d('2026-05-10T21:00:00Z') });
    expect(await streakOf(user._id)).toMatchObject({
      current: 1,
      lastActiveDate: d('2026-05-10T09:00:00Z'),
    });

    await updateStreak(user._id, { now: d('2026-05-11T09:00:00Z') });
    await updateStreak(user._id, { now: d('2026-05-12T09:00:00Z') });
    expect(await streakOf(user._id)).toMatchObject({ current: 3, longest: 3 });

    // Skipped May 13th: starts over, longest remembers the best run.
    await updateStreak(user._id, { now: d('2026-05-14T09:00:00Z') });
    expect(await streakOf(user._id)).toMatchObject({ current: 1, longest: 3 });

    await updateStreak(user._id, { now: d('2026-05-15T09:00:00Z') });
    expect(await streakOf(user._id)).toMatchObject({ current: 2, longest: 3 });
  });

  it("uses the timezone stored in the user's profile", async () => {
    const user = await makeUser();
    await Profile.create({ user: user._id, academicLevel: 'other', timezone: 'Asia/Tokyo' });

    await updateStreak(user._id, { now: d('2026-05-13T14:00:00Z') });
    // 2 hours later but already the next day in Tokyo.
    await updateStreak(user._id, { now: d('2026-05-13T16:00:00Z') });
    expect(await streakOf(user._id)).toMatchObject({ current: 2 });
  });

  it('falls back to UTC without a profile', async () => {
    const user = await makeUser();
    await updateStreak(user._id, { now: d('2026-05-13T23:30:00Z') });
    await updateStreak(user._id, { now: d('2026-05-14T00:30:00Z') });
    expect(await streakOf(user._id)).toMatchObject({ current: 2 });
  });

  it('counts concurrent events of the same day once', async () => {
    const user = await makeUser();
    const now = d('2026-05-13T10:00:00Z');
    await Promise.all(Array.from({ length: 6 }, () => updateStreak(user._id, { now })));
    expect(await streakOf(user._id)).toMatchObject({ current: 1, longest: 1 });
  });

  it('returns null for an unknown user', async () => {
    expect(await updateStreak('64b000000000000000000001')).toBeNull();
  });
});

describe('logActivity hook', () => {
  const makeUser = () =>
    User.create({ name: 'Ada', email: `u${Math.random()}@example.com`, passwordHash: 'x' });

  it.each(STREAK_ACTIVITY_TYPES)('%s updates the streak', async (type) => {
    const user = await makeUser();
    const event = await logActivity({ user: user._id, type });
    expect(event).not.toBeNull();

    const stored = (await User.findById(user._id).lean()).streak;
    expect(stored.current).toBe(1);
    expect(stored.lastActiveDate).toEqual(event.createdAt);
  });

  it.each(['lesson_opened', 'session_started', 'task_completed', 'onboarding_completed'])(
    '%s does not touch the streak',
    async (type) => {
      const user = await makeUser();
      await logActivity({ user: user._id, type });
      expect((await User.findById(user._id).lean()).streak.current).toBe(0);
    },
  );

  it('never throws when the streak update fails, and still logs the event', async () => {
    const user = await makeUser();
    jest.spyOn(User, 'findById').mockImplementation(() => {
      throw new Error('database exploded');
    });

    const event = await logActivity({ user: user._id, type: 'quiz_submitted' });
    expect(event).not.toBeNull();
    expect(await ActivityLog.countDocuments({ user: user._id })).toBe(1);
  });
});

describe('streak through the API', () => {
  const onboard = (token, extra = {}) =>
    request(app)
      .post(`${API}/onboarding`)
      .set(bearer(token))
      .send({ ...validOnboarding, ...extra });
  const patchProfile = (token, body) =>
    request(app).patch(`${API}/profile`).set(bearer(token)).send(body);

  it('reviewing a flashcard and completing a lesson start and keep today streak', async () => {
    const { id, token } = await registerUser();
    const subject = await createSubject(token);
    const topic = await createTopic(token, subject.id);
    const card = (await createCard(token, topic.id)).body.data.flashcard;
    await createLesson(token, topic.id);

    await api('post', `/flashcards/${card.id}/review`, token, { rating: 'good' });
    await api('post', `/topics/${topic.id}/lesson/complete`, token);

    const { streak } = await User.findById(id).lean();
    expect(streak).toMatchObject({ current: 1, longest: 1 });
  });

  describe('PATCH /profile timezone', () => {
    it('accepts a valid timezone and stores the canonical name', async () => {
      const { token } = await registerUser();
      await onboard(token);

      const res = await patchProfile(token, { timezone: 'europe/paris' });
      expect(res.status).toBe(200);
      expect(res.body.data.profile.timezone).toBe('Europe/Paris');
    });

    it('can be cleared with null and defaults to null', async () => {
      const { token } = await registerUser();
      const onboarded = await onboard(token);
      expect(onboarded.body.data.profile.timezone).toBeNull();

      await patchProfile(token, { timezone: 'Asia/Tokyo' });
      const res = await patchProfile(token, { timezone: null });
      expect(res.status).toBe(200);
      expect(res.body.data.profile.timezone).toBeNull();
    });

    it.each([['Mars/Base'], [''], [42]])('rejects %p', async (timezone) => {
      const { token } = await registerUser();
      await onboard(token);
      const res = await patchProfile(token, { timezone });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });
});
