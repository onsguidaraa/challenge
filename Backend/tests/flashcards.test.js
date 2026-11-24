import request from 'supertest';
import app from '../src/app.js';
import { Flashcard } from '../src/modules/practice/practice.model.js';
import { ActivityLog } from '../src/modules/activity-log/activity-log.model.js';
import { startTestDb, clearTestDb, stopTestDb } from './helpers/db.js';
import { API, registerUser } from './helpers/auth.js';
import { api, createSubject, createTopic } from './helpers/space.js';
import { createCard } from './helpers/practice.js';

beforeAll(async () => {
  await startTestDb();
}, 120000);

afterEach(async () => {
  await clearTestDb();
});

afterAll(async () => {
  await stopTestDb();
});

const fakeId = '64b000000000000000000001';
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const setup = async (email = 'ada@example.com') => {
  const user = await registerUser(email);
  const subject = await createSubject(user.token);
  const topic = await createTopic(user.token, subject.id);
  return { ...user, subject, topic };
};

/** Creates a card and moves its nextReview to `now + offsetMs`. */
const cardDueIn = async (token, topicId, offsetMs, front = `card ${offsetMs}`) => {
  const res = await createCard(token, topicId, { front, back: 'answer' });
  const card = res.body.data.flashcard;
  await Flashcard.updateOne({ _id: card.id }, { nextReview: new Date(Date.now() + offsetMs) });
  return card;
};

describe('authentication and ids', () => {
  it.each([
    ['post', `/topics/${fakeId}/flashcards`],
    ['post', `/topics/${fakeId}/flashcards/bulk`],
    ['get', `/topics/${fakeId}/flashcards`],
    ['get', '/flashcards/due'],
    ['get', '/flashcards/stats'],
    ['get', `/flashcards/${fakeId}`],
    ['patch', `/flashcards/${fakeId}`],
    ['delete', `/flashcards/${fakeId}`],
    ['post', `/flashcards/${fakeId}/review`],
  ])('%s %s requires authentication', async (method, path) => {
    const res = await request(app)[method](`${API}${path}`);
    expect(res.status).toBe(401);
  });

  it('rejects malformed ids with 400 and unknown ones with 404', async () => {
    const { token } = await registerUser();
    expect((await api('get', '/flashcards/nope', token)).status).toBe(400);
    expect((await api('post', '/flashcards/nope/review', token, { rating: 'good' })).status).toBe(
      400,
    );
    expect((await api('get', '/flashcards/due?topic=nope', token)).status).toBe(400);
    expect((await api('get', `/flashcards/${fakeId}`, token)).status).toBe(404);
    expect((await api('get', `/topics/${fakeId}/flashcards`, token)).status).toBe(404);
  });
});

describe('flashcard CRUD', () => {
  it('creates a card with the SM-2 defaults and cannot set scheduling fields', async () => {
    const { token, id, topic } = await setup();
    const before = Date.now();
    const res = await api('post', `/topics/${topic.id}/flashcards`, token, {
      front: '  What is a derivative? ',
      back: 'A rate of change.',
      easeFactor: 9,
      intervalDays: 99,
      repetitions: 5,
      nextReview: '2099-01-01T00:00:00.000Z',
    });

    expect(res.status).toBe(201);
    const card = res.body.data.flashcard;
    expect(card).toMatchObject({
      user: id,
      topic: topic.id,
      front: 'What is a derivative?',
      back: 'A rate of change.',
      easeFactor: 2.5,
      intervalDays: 0,
      repetitions: 0,
      lastReviewedAt: null,
    });
    expect(new Date(card.nextReview).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(new Date(card.nextReview).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it.each([
    ['blank front', { front: '  ', back: 'b' }],
    ['missing back', { front: 'f' }],
    ['too long', { front: 'x'.repeat(2001), back: 'b' }],
  ])('rejects %s', async (_name, body) => {
    const { token, topic } = await setup();
    const res = await api('post', `/topics/${topic.id}/flashcards`, token, body);
    expect(res.status).toBe(400);
  });

  it('lists a topic’s cards paginated, gets, updates and deletes one', async () => {
    const { token, subject, topic } = await setup();
    const a = (await createCard(token, topic.id, { front: 'A', back: '1' })).body.data.flashcard;
    await createCard(token, topic.id, { front: 'B', back: '2' });
    const otherTopic = await createTopic(token, subject.id, 'Integrals');
    await createCard(token, otherTopic.id);

    const list = await api('get', `/topics/${topic.id}/flashcards?limit=1`, token);
    expect(list.body.data).toMatchObject({ page: 1, limit: 1, total: 2 });
    expect(list.body.data.items[0].front).toBe('B');

    const read = await api('get', `/flashcards/${a.id}`, token);
    expect(read.body.data.flashcard).toMatchObject({ id: a.id, front: 'A' });

    const patched = await api('patch', `/flashcards/${a.id}`, token, {
      back: 'edited',
      easeFactor: 1.3,
    });
    expect(patched.status).toBe(200);
    expect(patched.body.data.flashcard).toMatchObject({ back: 'edited', easeFactor: 2.5 });
    expect((await api('patch', `/flashcards/${a.id}`, token, {})).status).toBe(400);
    expect((await api('patch', `/flashcards/${a.id}`, token, { front: ' ' })).status).toBe(400);

    const del = await api('delete', `/flashcards/${a.id}`, token);
    expect(del.status).toBe(200);
    expect(del.body.data).toEqual({ id: a.id });
    expect((await api('get', `/flashcards/${a.id}`, token)).status).toBe(404);
  });

  it('is removed together with its topic', async () => {
    const { token, id, topic } = await setup();
    await createCard(token, topic.id);
    const res = await api('delete', `/topics/${topic.id}`, token);
    expect(res.body.data.deleted).toMatchObject({ flashcards: 1 });
    expect(await Flashcard.countDocuments({ user: id })).toBe(0);
  });
});

describe('POST /topics/:topicId/flashcards/bulk', () => {
  it('creates all cards at once', async () => {
    const { token, id, topic } = await setup();
    const cards = Array.from({ length: 5 }, (_v, i) => ({ front: `Q${i}`, back: `A${i}` }));
    const res = await api('post', `/topics/${topic.id}/flashcards/bulk`, token, { cards });

    expect(res.status).toBe(201);
    expect(res.body.data.count).toBe(5);
    expect(res.body.data.items.map((c) => c.front)).toEqual(['Q0', 'Q1', 'Q2', 'Q3', 'Q4']);
    expect(res.body.data.items[0]).toMatchObject({ user: id, topic: topic.id, easeFactor: 2.5 });
    expect(await Flashcard.countDocuments({ user: id, topic: topic.id })).toBe(5);
  });

  it('creates nothing when any card is invalid, or the list is empty or too long', async () => {
    const { token, id, topic } = await setup();
    const url = `/topics/${topic.id}/flashcards/bulk`;

    const bad = await api('post', url, token, {
      cards: [
        { front: 'ok', back: 'ok' },
        { front: '', back: 'x' },
      ],
    });
    expect(bad.status).toBe(400);
    expect((await api('post', url, token, { cards: [] })).status).toBe(400);
    const tooMany = Array.from({ length: 101 }, () => ({ front: 'f', back: 'b' }));
    expect((await api('post', url, token, { cards: tooMany })).status).toBe(400);
    expect(await Flashcard.countDocuments({ user: id })).toBe(0);
  });

  it('returns 404 for a topic of another user', async () => {
    const { topic } = await setup();
    const other = await registerUser('grace@example.com');
    const res = await api('post', `/topics/${topic.id}/flashcards/bulk`, other.token, {
      cards: [{ front: 'f', back: 'b' }],
    });
    expect(res.status).toBe(404);
    expect(await Flashcard.countDocuments()).toBe(0);
  });
});

describe('GET /flashcards/due', () => {
  it('returns only cards with nextReview <= now, most overdue first', async () => {
    const { token, topic } = await setup();
    const fresh = (await createCard(token, topic.id, { front: 'fresh', back: 'b' })).body.data
      .flashcard;
    const overdue = await cardDueIn(token, topic.id, -2 * DAY, 'overdue');
    const recent = await cardDueIn(token, topic.id, -HOUR, 'recent');
    await cardDueIn(token, topic.id, HOUR, 'later today');
    await cardDueIn(token, topic.id, 3 * DAY, 'future');

    const res = await api('get', '/flashcards/due', token);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ page: 1, limit: 20, total: 3 });
    expect(res.body.data.items.map((c) => c.id)).toEqual([overdue.id, recent.id, fresh.id]);
  });

  it('returns nothing when no card is due', async () => {
    const { token, topic } = await setup();
    await cardDueIn(token, topic.id, DAY);
    const res = await api('get', '/flashcards/due', token);
    expect(res.body.data).toMatchObject({ total: 0, items: [] });
  });

  it('honours limit and page', async () => {
    const { token, topic } = await setup();
    const ids = [];
    for (let i = 5; i >= 1; i -= 1) ids.push((await cardDueIn(token, topic.id, -i * HOUR)).id);

    const first = await api('get', '/flashcards/due?limit=2', token);
    expect(first.body.data).toMatchObject({ limit: 2, total: 5 });
    expect(first.body.data.items.map((c) => c.id)).toEqual(ids.slice(0, 2));

    const third = await api('get', '/flashcards/due?limit=2&page=3', token);
    expect(third.body.data.items.map((c) => c.id)).toEqual(ids.slice(4));
    expect((await api('get', '/flashcards/due?limit=0', token)).status).toBe(400);
    expect((await api('get', '/flashcards/due?limit=101', token)).status).toBe(400);
  });

  it('filters by topic', async () => {
    const { token, subject, topic } = await setup();
    const topicB = await createTopic(token, subject.id, 'Integrals');
    await cardDueIn(token, topic.id, -HOUR, 'a');
    const b = await cardDueIn(token, topicB.id, -HOUR, 'b');

    const res = await api('get', `/flashcards/due?topic=${topicB.id}`, token);
    expect(res.body.data.items.map((c) => c.id)).toEqual([b.id]);
  });

  it("never returns another user's cards, nor accepts their topic", async () => {
    const { token, topic } = await setup();
    await cardDueIn(token, topic.id, -HOUR);
    const other = await registerUser('grace@example.com');

    expect((await api('get', '/flashcards/due', other.token)).body.data.total).toBe(0);
    expect((await api('get', `/flashcards/due?topic=${topic.id}`, other.token)).status).toBe(404);
  });
});

describe('GET /flashcards/stats', () => {
  it('counts due now, due today and total', async () => {
    const { token, topic } = await setup();
    const endOfToday = new Date();
    endOfToday.setUTCHours(23, 59, 59, 999);

    await cardDueIn(token, topic.id, -DAY); // due now
    await cardDueIn(token, topic.id, -MINUTE); // due now
    const later = await cardDueIn(token, topic.id, HOUR); // placeholder, moved below
    await Flashcard.updateOne({ _id: later.id }, { nextReview: endOfToday }); // due later today
    await cardDueIn(token, topic.id, 3 * DAY); // future

    const res = await api('get', '/flashcards/stats', token);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ dueNow: 2, dueToday: 3, total: 4 });
  });

  it('is zero for a user without cards, scoped by topic and by user', async () => {
    const { token, subject, topic } = await setup();
    const topicB = await createTopic(token, subject.id, 'Integrals');
    await cardDueIn(token, topic.id, -HOUR);
    await cardDueIn(token, topicB.id, -HOUR);
    await cardDueIn(token, topicB.id, -HOUR);

    const byTopic = await api('get', `/flashcards/stats?topic=${topicB.id}`, token);
    expect(byTopic.body.data).toEqual({ dueNow: 2, dueToday: 2, total: 2 });

    const other = await registerUser('grace@example.com');
    expect((await api('get', '/flashcards/stats', other.token)).body.data).toEqual({
      dueNow: 0,
      dueToday: 0,
      total: 0,
    });
    expect((await api('get', `/flashcards/stats?topic=${topic.id}`, other.token)).status).toBe(404);
  });
});

describe('POST /flashcards/:id/review', () => {
  const review = (token, id, rating) => api('post', `/flashcards/${id}/review`, token, { rating });

  it('schedules the next review with SM-2 and stores it', async () => {
    const { token, topic } = await setup();
    const card = (await createCard(token, topic.id)).body.data.flashcard;

    const first = await review(token, card.id, 'good');
    expect(first.status).toBe(200);
    expect(first.body.data.flashcard).toMatchObject({
      easeFactor: 2.5,
      intervalDays: 1,
      repetitions: 1,
    });
    const reviewedAt = new Date(first.body.data.flashcard.lastReviewedAt).getTime();
    expect(new Date(first.body.data.flashcard.nextReview).getTime()).toBe(reviewedAt + DAY);

    const second = await review(token, card.id, 'easy');
    expect(second.body.data.flashcard).toMatchObject({
      easeFactor: 2.6,
      intervalDays: 6,
      repetitions: 2,
    });

    const stored = await Flashcard.findById(card.id);
    expect(stored).toMatchObject({ easeFactor: 2.6, intervalDays: 6, repetitions: 2 });
  });

  it('resets a lapsed card on "again" and brings it back within minutes', async () => {
    const { token, topic } = await setup();
    const card = (await createCard(token, topic.id)).body.data.flashcard;
    await review(token, card.id, 'good');
    await review(token, card.id, 'good');

    const res = await review(token, card.id, 'again');
    const updated = res.body.data.flashcard;
    expect(updated).toMatchObject({ easeFactor: 2.3, intervalDays: 0, repetitions: 0 });
    const delay =
      new Date(updated.nextReview).getTime() - new Date(updated.lastReviewedAt).getTime();
    expect(delay).toBe(10 * MINUTE);
  });

  it('moves a card out of the due list', async () => {
    const { token, topic } = await setup();
    const card = (await createCard(token, topic.id)).body.data.flashcard;
    expect((await api('get', '/flashcards/due', token)).body.data.total).toBe(1);

    await review(token, card.id, 'good');
    expect((await api('get', '/flashcards/due', token)).body.data.total).toBe(0);
    expect((await api('get', '/flashcards/stats', token)).body.data).toMatchObject({
      dueNow: 0,
      total: 1,
    });
  });

  it('logs flashcard_reviewed with the rating and topic', async () => {
    const { token, id, topic } = await setup();
    const card = (await createCard(token, topic.id)).body.data.flashcard;
    await review(token, card.id, 'hard');

    const events = await ActivityLog.find({ user: id, type: 'flashcard_reviewed' });
    expect(events).toHaveLength(1);
    expect(String(events[0].refId)).toBe(card.id);
    expect(events[0].metadata).toMatchObject({
      rating: 'hard',
      topicId: topic.id,
      intervalDays: 1,
      repetitions: 1,
    });
  });

  it('rejects an unknown or missing rating without changing the card', async () => {
    const { token, id, topic } = await setup();
    const card = (await createCard(token, topic.id)).body.data.flashcard;

    expect((await review(token, card.id, 'perfect')).status).toBe(400);
    expect((await api('post', `/flashcards/${card.id}/review`, token, {})).status).toBe(400);
    expect((await Flashcard.findById(card.id)).repetitions).toBe(0);
    expect(await ActivityLog.countDocuments({ user: id, type: 'flashcard_reviewed' })).toBe(0);
  });
});

describe('ownership isolation', () => {
  it("returns 404 for another user's card on every route and changes nothing", async () => {
    const { token, topic } = await setup();
    const card = (await createCard(token, topic.id)).body.data.flashcard;
    const other = await registerUser('grace@example.com');

    expect((await api('get', `/flashcards/${card.id}`, other.token)).status).toBe(404);
    expect((await api('patch', `/flashcards/${card.id}`, other.token, { front: 'x' })).status).toBe(
      404,
    );
    expect((await api('delete', `/flashcards/${card.id}`, other.token)).status).toBe(404);
    expect(
      (await api('post', `/flashcards/${card.id}/review`, other.token, { rating: 'good' })).status,
    ).toBe(404);
    expect((await api('get', `/topics/${topic.id}/flashcards`, other.token)).status).toBe(404);
    expect(
      (
        await api('post', `/topics/${topic.id}/flashcards`, other.token, {
          front: 'f',
          back: 'b',
        })
      ).status,
    ).toBe(404);

    const stored = await Flashcard.findById(card.id);
    expect(stored).toMatchObject({ front: 'Q?', repetitions: 0 });
    expect(await Flashcard.countDocuments()).toBe(1);
  });
});
