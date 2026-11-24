import { jest } from '@jest/globals';
import request from 'supertest';
import mongoose from 'mongoose';
import app from '../src/app.js';
import { Topic } from '../src/modules/space/space.model.js';
import { Lesson } from '../src/modules/lessons/lessons.model.js';
import { ActivityLog } from '../src/modules/activity-log/activity-log.model.js';
import { Profile } from '../src/modules/profile/profile.model.js';
import { startTestDb, clearTestDb, stopTestDb } from './helpers/db.js';
import { API, registerUser, validOnboarding } from './helpers/auth.js';
import { api, createSubject, createTopic, createLesson, fullLesson } from './helpers/space.js';

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

const setup = async (email = 'ada@example.com') => {
  const user = await registerUser(email);
  const subject = await createSubject(user.token);
  const topic = await createTopic(user.token, subject.id);
  return { ...user, subject, topic };
};

const topicStatus = async (token, topicId) =>
  (await api('get', `/topics/${topicId}`, token)).body.data.topic.status;

const waitFor = async (check, { tries = 50, delay = 20 } = {}) => {
  for (let i = 0; i < tries; i += 1) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new Error('Condition not met in time');
};

describe('authentication', () => {
  const id = '64b000000000000000000001';
  it.each([
    ['put', `/topics/${id}/lesson`],
    ['patch', `/topics/${id}/lesson`],
    ['delete', `/topics/${id}/lesson`],
    ['get', `/topics/${id}/lesson`],
    ['get', `/topics/${id}/lesson/formats`],
    ['post', `/topics/${id}/lesson/complete`],
  ])('%s %s requires authentication', async (method, path) => {
    const res = await request(app)[method](`${API}${path}`);
    expect(res.status).toBe(401);
  });

  it('rejects malformed topic ids', async () => {
    const { token } = await registerUser();
    for (const path of ['', '/formats']) {
      const res = await api('get', `/topics/nope/lesson${path}`, token);
      expect(res.status).toBe(400);
    }
  });
});

describe('PUT /topics/:topicId/lesson', () => {
  it('creates a lesson (201) and replaces it (200), keeping one per topic', async () => {
    const { token, topic, id } = await setup();

    const created = await createLesson(token, topic.id);
    expect(created.status).toBe(201);
    expect(created.body.data.lesson).toMatchObject({
      topic: topic.id,
      user: id,
      title: fullLesson.title,
      completed: false,
      completedAt: null,
      exercises: [],
    });
    // Steps are sorted by order.
    expect(created.body.data.lesson.formats.steps.map((s) => s.order)).toEqual([1, 2]);
    expect(created.body.data.lesson.formats.diagram).toEqual({
      type: 'mermaid',
      source: 'graph TD; A-->B',
    });

    const replaced = await createLesson(token, topic.id, {
      title: 'Rewritten',
      formats: { simplified: 'Just this' },
    });
    expect(replaced.status).toBe(200);
    expect(replaced.body.data.lesson.id).toBe(created.body.data.lesson.id);
    expect(replaced.body.data.lesson).toMatchObject({
      title: 'Rewritten',
      formats: { simplified: 'Just this', diagram: null, steps: [], examples: [] },
    });
    expect(await Lesson.countDocuments({ topic: topic.id })).toBe(1);
  });

  it('keeps completion state when replaced', async () => {
    const { token, topic } = await setup();
    await createLesson(token, topic.id);
    await api('post', `/topics/${topic.id}/lesson/complete`, token);

    const replaced = await createLesson(token, topic.id, {
      title: 'v2',
      formats: { simplified: 'new' },
    });
    expect(replaced.body.data.lesson.completed).toBe(true);
    expect(replaced.body.data.lesson.completedAt).not.toBeNull();
  });

  it('numbers steps without an explicit order', async () => {
    const { token, topic } = await setup();
    const res = await createLesson(token, topic.id, {
      title: 'T',
      formats: {
        steps: [
          { title: 'a', content: 'a' },
          { title: 'b', content: 'b' },
        ],
      },
    });
    expect(res.body.data.lesson.formats.steps.map((s) => [s.order, s.title])).toEqual([
      [1, 'a'],
      [2, 'b'],
    ]);
  });

  it('validates the body', async () => {
    const { token, topic } = await setup();
    const invalid = [
      {},
      { title: 'No formats' },
      { title: 'Empty formats', formats: {} },
      { title: 'Only blanks', formats: { simplified: '  ', steps: [], examples: [] } },
      { formats: { simplified: 'no title' } },
      { title: 'T', formats: { diagram: { type: 'png', source: 'x' } } },
      { title: 'T', formats: { diagram: { type: 'mermaid', source: '' } } },
      { title: 'T', formats: { diagram: { type: 'svg', source: 'graph TD' } } },
      {
        title: 'T',
        formats: { diagram: { type: 'svg', source: '<svg><script>x</script></svg>' } },
      },
      {
        title: 'T',
        formats: { diagram: { type: 'svg', source: '<svg onload="alert(1)"></svg>' } },
      },
      { title: 'T', formats: { steps: [{ title: 'no content' }] } },
      { title: 'T', formats: { examples: [{ content: 'no title' }] } },
      { title: 'T', formats: { steps: [{ order: 0, title: 'a', content: 'a' }] } },
    ];
    for (const body of invalid) {
      const res = await createLesson(token, topic.id, body);
      expect([body, res.status]).toEqual([body, 400]);
    }
    expect(await Lesson.countDocuments()).toBe(0);
  });

  it('accepts a safe svg diagram', async () => {
    const { token, topic } = await setup();
    const res = await createLesson(token, topic.id, {
      title: 'T',
      formats: { diagram: { type: 'svg', source: '<svg><circle r="5"/></svg>' } },
    });
    expect(res.status).toBe(201);
  });

  it('ignores exercises on PUT (they are only set through PATCH)', async () => {
    const { token, topic } = await setup();
    const res = await createLesson(token, topic.id, {
      ...fullLesson,
      exercises: [String(new mongoose.Types.ObjectId())],
    });
    expect(res.status).toBe(201);
    expect(res.body.data.lesson.exercises).toEqual([]);
  });

  it('404s for an unknown topic', async () => {
    const { token } = await registerUser();
    const res = await createLesson(token, String(new mongoose.Types.ObjectId()));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('TOPIC_NOT_FOUND');
  });
});

describe('PATCH /topics/:topicId/lesson', () => {
  it('updates only the supplied keys', async () => {
    const { token, topic } = await setup();
    await createLesson(token, topic.id);

    const res = await api('patch', `/topics/${topic.id}/lesson`, token, {
      title: 'Patched',
      formats: { simplified: 'Shorter' },
    });
    expect(res.status).toBe(200);
    const { lesson } = res.body.data;
    expect(lesson.title).toBe('Patched');
    expect(lesson.formats.simplified).toBe('Shorter');
    expect(lesson.formats.diagram).toEqual(fullLesson.formats.diagram);
    expect(lesson.formats.steps).toHaveLength(2);
    expect(lesson.formats.examples).toHaveLength(1);
  });

  it('clears a format when given an empty value', async () => {
    const { token, topic } = await setup();
    await createLesson(token, topic.id);

    const res = await api('patch', `/topics/${topic.id}/lesson`, token, {
      formats: { diagram: null, steps: [], simplified: '' },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.lesson.formats).toMatchObject({
      simplified: '',
      diagram: null,
      steps: [],
    });

    const formats = await api('get', `/topics/${topic.id}/lesson/formats`, token);
    expect(formats.body.data.available).toEqual(['examples']);
  });

  it('validates the body and requires an existing lesson', async () => {
    const { token, topic } = await setup();

    const noLesson = await api('patch', `/topics/${topic.id}/lesson`, token, { title: 'x' });
    expect(noLesson.status).toBe(404);
    expect(noLesson.body.error.code).toBe('LESSON_NOT_FOUND');

    await createLesson(token, topic.id);
    for (const body of [{}, { formats: {} }, { title: ' ' }, { formats: { steps: [{}] } }]) {
      expect((await api('patch', `/topics/${topic.id}/lesson`, token, body)).status).toBe(400);
    }
  });
});

describe('DELETE /topics/:topicId/lesson', () => {
  it('deletes the lesson and 404s afterwards', async () => {
    const { token, topic } = await setup();
    await createLesson(token, topic.id);

    expect((await api('delete', `/topics/${topic.id}/lesson`, token)).status).toBe(200);
    expect(await Lesson.countDocuments()).toBe(0);
    expect((await api('get', `/topics/${topic.id}/lesson`, token)).status).toBe(404);
    expect((await api('delete', `/topics/${topic.id}/lesson`, token)).status).toBe(404);
    // The topic itself stays.
    expect((await api('get', `/topics/${topic.id}`, token)).status).toBe(200);
  });
});

describe('GET /topics/:topicId/lesson (format filtering)', () => {
  it('returns every format by default and with format=all', async () => {
    const { token, topic } = await setup();
    await createLesson(token, topic.id);

    for (const url of [`/topics/${topic.id}/lesson`, `/topics/${topic.id}/lesson?format=all`]) {
      const res = await api('get', url, token);
      expect(res.status).toBe(200);
      expect(res.body.data.format).toBe('all');
      expect(Object.keys(res.body.data.lesson.formats).sort()).toEqual([
        'diagram',
        'examples',
        'simplified',
        'steps',
      ]);
      expect(res.body.data.availableFormats).toEqual([
        'simplified',
        'diagram',
        'steps',
        'examples',
      ]);
    }
  });

  it.each([
    ['simplified', fullLesson.formats.simplified],
    ['diagram', fullLesson.formats.diagram],
    ['examples', fullLesson.formats.examples],
  ])('returns only the %s format', async (format, expected) => {
    const { token, topic } = await setup();
    await createLesson(token, topic.id);

    const res = await api('get', `/topics/${topic.id}/lesson?format=${format}`, token);
    expect(res.status).toBe(200);
    expect(res.body.data.format).toBe(format);
    expect(res.body.data.lesson.formats).toEqual({ [format]: expected });
    expect(res.body.data.lesson.title).toBe(fullLesson.title);
  });

  it('returns steps ordered', async () => {
    const { token, topic } = await setup();
    await createLesson(token, topic.id);
    const res = await api('get', `/topics/${topic.id}/lesson?format=steps`, token);
    expect(Object.keys(res.body.data.lesson.formats)).toEqual(['steps']);
    expect(res.body.data.lesson.formats.steps.map((s) => s.title)).toEqual([
      'Identify the power',
      'Apply the rule',
    ]);
  });

  it('rejects an unknown format with 400', async () => {
    const { token, topic } = await setup();
    await createLesson(token, topic.id);
    const res = await api('get', `/topics/${topic.id}/lesson?format=audio`, token);
    expect(res.status).toBe(400);
  });

  it('returns 404 LESSON_NOT_FOUND when the topic has no lesson', async () => {
    const { token, topic } = await setup();
    const res = await api('get', `/topics/${topic.id}/lesson`, token);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('LESSON_NOT_FOUND');
  });

  it('returns 404 FORMAT_NOT_AVAILABLE and lists the formats that exist', async () => {
    const { token, topic, id } = await setup();
    await createLesson(token, topic.id, {
      title: 'Partial',
      formats: { simplified: 'Only text', examples: [{ title: 'e', content: 'c' }] },
    });

    const res = await api('get', `/topics/${topic.id}/lesson?format=diagram`, token);
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('FORMAT_NOT_AVAILABLE');
    expect(res.body.error.details).toEqual({
      requested: 'diagram',
      available: ['simplified', 'examples'],
    });

    // A failed read is not an "open": no activity, no status change.
    expect(await ActivityLog.countDocuments({ user: id })).toBe(0);
    expect(await topicStatus(token, topic.id)).toBe('not_started');

    expect((await api('get', `/topics/${topic.id}/lesson?format=steps`, token)).status).toBe(404);
    expect((await api('get', `/topics/${topic.id}/lesson?format=simplified`, token)).status).toBe(
      200,
    );
  });
});

describe('GET /topics/:topicId/lesson/formats', () => {
  it('reports which formats are available', async () => {
    const { token, topic } = await setup();
    await createLesson(token, topic.id, {
      title: 'Partial',
      formats: { simplified: 'text', steps: [{ title: 's', content: 'c' }] },
    });

    const res = await api('get', `/topics/${topic.id}/lesson/formats`, token);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      formats: { simplified: true, diagram: false, steps: true, examples: false },
      available: ['simplified', 'steps'],
    });
  });

  it('does not count as opening the lesson', async () => {
    const { token, topic, id } = await setup();
    await createLesson(token, topic.id);
    await api('get', `/topics/${topic.id}/lesson/formats`, token);
    expect(await topicStatus(token, topic.id)).toBe('not_started');
    expect(await ActivityLog.countDocuments({ user: id })).toBe(0);
  });

  it('404s without a lesson', async () => {
    const { token, topic } = await setup();
    const res = await api('get', `/topics/${topic.id}/lesson/formats`, token);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('LESSON_NOT_FOUND');
  });
});

describe('activity logging and learned stats on open', () => {
  it('logs lesson_opened with metadata.format when a specific format is fetched', async () => {
    const { token, topic, id } = await setup();
    const created = await createLesson(token, topic.id);

    await api('get', `/topics/${topic.id}/lesson?format=diagram`, token);
    await api('get', `/topics/${topic.id}/lesson?format=steps`, token);

    const events = await ActivityLog.find({ user: id, type: 'lesson_opened' }).sort({
      createdAt: 1,
    });
    expect(events.map((e) => e.metadata.format)).toEqual(['diagram', 'steps']);
    expect(events[0]).toMatchObject({ refModel: 'Lesson' });
    expect(String(events[0].refId)).toBe(created.body.data.lesson.id);
    expect(events[0].metadata.topicId).toBe(topic.id);
  });

  it('does not log when fetching format=all', async () => {
    const { token, topic, id } = await setup();
    await createLesson(token, topic.id);
    await api('get', `/topics/${topic.id}/lesson`, token);
    await api('get', `/topics/${topic.id}/lesson?format=all`, token);
    expect(await ActivityLog.countDocuments({ user: id })).toBe(0);
  });

  it('recomputes learned stats in the background', async () => {
    const user = await setup();
    await request(app)
      .post(`${API}/onboarding`)
      .set({ Authorization: `Bearer ${user.token}` })
      .send(validOnboarding);
    await createLesson(user.token, user.topic.id);

    const res = await api('get', `/topics/${user.topic.id}/lesson?format=diagram`, user.token);
    expect(res.status).toBe(200);

    const profile = await waitFor(async () => {
      const p = await Profile.findOne({ user: user.id });
      return p?.learnedStats?.formatUsage?.diagram === 1 ? p : null;
    });
    expect(profile.learnedStats.lastComputedAt).not.toBeNull();
  });

  it('still opens the lesson when logging or stats fail', async () => {
    const { token, topic } = await setup();
    await createLesson(token, topic.id);
    jest.spyOn(ActivityLog, 'create').mockRejectedValue(new Error('db down'));
    jest.spyOn(Profile, 'findOneAndUpdate').mockRejectedValue(new Error('db down'));

    const res = await api('get', `/topics/${topic.id}/lesson?format=simplified`, token);
    expect(res.status).toBe(200);
  });
});

describe('topic status transitions', () => {
  it('moves not_started to in_progress on first open', async () => {
    const { token, topic } = await setup();
    await createLesson(token, topic.id);
    expect(await topicStatus(token, topic.id)).toBe('not_started');

    await api('get', `/topics/${topic.id}/lesson?format=simplified`, token);
    expect(await topicStatus(token, topic.id)).toBe('in_progress');
  });

  it('also moves to in_progress when fetching all formats', async () => {
    const { token, topic } = await setup();
    await createLesson(token, topic.id);
    await api('get', `/topics/${topic.id}/lesson`, token);
    expect(await topicStatus(token, topic.id)).toBe('in_progress');
  });

  it('never moves a completed topic back to in_progress', async () => {
    const { token, topic } = await setup();
    await createLesson(token, topic.id);
    await api('post', `/topics/${topic.id}/lesson/complete`, token);

    await api('get', `/topics/${topic.id}/lesson?format=simplified`, token);
    expect(await topicStatus(token, topic.id)).toBe('completed');
  });

  it('leaves an in_progress topic alone', async () => {
    const { token, topic } = await setup();
    await createLesson(token, topic.id);
    await api('patch', `/topics/${topic.id}`, token, { status: 'in_progress' });
    await api('get', `/topics/${topic.id}/lesson`, token);
    expect(await topicStatus(token, topic.id)).toBe('in_progress');
  });

  it('not_started -> in_progress -> completed through the lesson flow', async () => {
    const { token, topic } = await setup();
    await createLesson(token, topic.id);

    const seen = [await topicStatus(token, topic.id)];
    await api('get', `/topics/${topic.id}/lesson?format=steps`, token);
    seen.push(await topicStatus(token, topic.id));
    await api('post', `/topics/${topic.id}/lesson/complete`, token);
    seen.push(await topicStatus(token, topic.id));

    expect(seen).toEqual(['not_started', 'in_progress', 'completed']);
  });
});

describe('POST /topics/:topicId/lesson/complete', () => {
  it('completes the lesson and topic and logs lesson_completed', async () => {
    const { token, topic, id } = await setup();
    const created = await createLesson(token, topic.id);

    const res = await api('post', `/topics/${topic.id}/lesson/complete`, token);
    expect(res.status).toBe(200);
    expect(res.body.data.topicStatus).toBe('completed');
    expect(res.body.data.lesson).toMatchObject({
      id: created.body.data.lesson.id,
      completed: true,
    });
    expect(res.body.data.lesson.completedAt).not.toBeNull();

    expect(await topicStatus(token, topic.id)).toBe('completed');
    const events = await ActivityLog.find({ user: id, type: 'lesson_completed' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ refModel: 'Lesson' });
    expect(String(events[0].refId)).toBe(created.body.data.lesson.id);

    const subject = await api('get', `/subjects/${topic.subject}`, token);
    expect(subject.body.data.subject).toMatchObject({ topicCount: 1, completedTopicCount: 1 });
  });

  it('is idempotent and only logs once', async () => {
    const { token, topic, id } = await setup();
    await createLesson(token, topic.id);

    const first = await api('post', `/topics/${topic.id}/lesson/complete`, token);
    const second = await api('post', `/topics/${topic.id}/lesson/complete`, token);
    expect(second.status).toBe(200);
    expect(second.body.data.lesson.completedAt).toBe(first.body.data.lesson.completedAt);
    expect(await ActivityLog.countDocuments({ user: id, type: 'lesson_completed' })).toBe(1);
  });

  it('404s without a lesson and leaves the topic unchanged', async () => {
    const { token, topic } = await setup();
    const res = await api('post', `/topics/${topic.id}/lesson/complete`, token);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('LESSON_NOT_FOUND');
    expect(await topicStatus(token, topic.id)).toBe('not_started');
  });
});

describe('ownership isolation', () => {
  it("cannot see or touch another user's lesson", async () => {
    const alice = await setup('alice@example.com');
    const bob = await registerUser('bob@example.com');
    await createLesson(alice.token, alice.topic.id);
    const t = alice.topic.id;

    const attempts = [
      createLesson(bob.token, t),
      api('patch', `/topics/${t}/lesson`, bob.token, { title: 'Hacked' }),
      api('delete', `/topics/${t}/lesson`, bob.token),
      api('get', `/topics/${t}/lesson`, bob.token),
      api('get', `/topics/${t}/lesson?format=simplified`, bob.token),
      api('get', `/topics/${t}/lesson/formats`, bob.token),
      api('post', `/topics/${t}/lesson/complete`, bob.token),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('TOPIC_NOT_FOUND');
    }

    const lesson = await Lesson.findOne({ topic: t });
    expect(lesson).toMatchObject({ title: fullLesson.title, completed: false });
    expect(String(lesson.user)).toBe(alice.id);
    expect(await Topic.findById(t)).toMatchObject({ status: 'not_started' });
    expect(await ActivityLog.countDocuments()).toBe(0);
  });
});
