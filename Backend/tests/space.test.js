import { jest } from '@jest/globals';
import request from 'supertest';
import mongoose from 'mongoose';
import app from '../src/app.js';
import { Subject, Topic, Material } from '../src/modules/space/space.model.js';
import { Lesson } from '../src/modules/lessons/lessons.model.js';
import { startTestDb, clearTestDb, stopTestDb } from './helpers/db.js';
import { API, registerUser } from './helpers/auth.js';
import { api, createSubject, createTopic, createNote, createLesson } from './helpers/space.js';

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

const twoUsers = async () => ({
  alice: await registerUser('alice@example.com'),
  bob: await registerUser('bob@example.com'),
});

const someId = () => String(new mongoose.Types.ObjectId());

describe('authentication', () => {
  const id = '64b000000000000000000001';
  it.each([
    ['post', '/subjects'],
    ['get', '/subjects'],
    ['get', `/subjects/${id}`],
    ['patch', `/subjects/${id}`],
    ['delete', `/subjects/${id}`],
    ['post', `/subjects/${id}/topics`],
    ['get', `/subjects/${id}/topics`],
    ['patch', `/subjects/${id}/topics/reorder`],
    ['get', `/topics/${id}`],
    ['patch', `/topics/${id}`],
    ['delete', `/topics/${id}`],
    ['post', `/topics/${id}/materials`],
    ['get', `/topics/${id}/materials`],
    ['get', `/materials/${id}`],
    ['patch', `/materials/${id}`],
    ['delete', `/materials/${id}`],
  ])('%s %s requires authentication', async (method, path) => {
    const res = await request(app)[method](`${API}${path}`);
    expect(res.status).toBe(401);
  });
});

describe('invalid ids', () => {
  it('returns 400 for malformed ids on every kind of route', async () => {
    const { token } = await registerUser();
    for (const path of [
      '/subjects/nope',
      '/subjects/nope/topics',
      '/topics/nope',
      '/topics/nope/materials',
      '/materials/nope',
    ]) {
      const res = await api('get', path, token);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
  });
});

describe('subjects', () => {
  it('creates a subject with defaults', async () => {
    const { token, id } = await registerUser();
    const res = await api('post', '/subjects', token, {
      name: '  Physics ',
      description: 'Mechanics',
      color: '#ff0000',
      icon: 'atom',
    });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.subject).toMatchObject({
      name: 'Physics',
      description: 'Mechanics',
      color: '#ff0000',
      icon: 'atom',
      archived: false,
      user: id,
      topicCount: 0,
      completedTopicCount: 0,
    });
  });

  it('validates the body', async () => {
    const { token } = await registerUser();
    expect((await api('post', '/subjects', token, {})).status).toBe(400);
    expect((await api('post', '/subjects', token, { name: 'x', color: 'red' })).status).toBe(400);
    expect((await api('post', '/subjects', token, { name: ' ' })).status).toBe(400);
  });

  it('enforces a unique name per user (case-insensitive) but not across users', async () => {
    const { alice, bob } = await twoUsers();
    await createSubject(alice.token, 'Math');

    const dup = await api('post', '/subjects', alice.token, { name: 'math' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('SUBJECT_NAME_TAKEN');

    expect((await api('post', '/subjects', bob.token, { name: 'Math' })).status).toBe(201);

    const other = await createSubject(alice.token, 'Biology');
    const rename = await api('patch', `/subjects/${other.id}`, alice.token, { name: 'MATH' });
    expect(rename.status).toBe(409);
    expect(rename.body.error.code).toBe('SUBJECT_NAME_TAKEN');
  });

  it('lists with topicCount / completedTopicCount, filters and pagination', async () => {
    const { token } = await registerUser();
    const math = await createSubject(token, 'Mathematics', { description: 'numbers and algebra' });
    const art = await createSubject(token, 'Art History');
    await api('patch', `/subjects/${art.id}`, token, { archived: true });

    const t1 = await createTopic(token, math.id, 'A');
    await createTopic(token, math.id, 'B');
    await createTopic(token, math.id, 'C');
    await api('patch', `/topics/${t1.id}`, token, { status: 'completed' });

    const all = await api('get', '/subjects', token);
    expect(all.status).toBe(200);
    expect(all.body.data).toMatchObject({ page: 1, limit: 20, total: 2 });
    const mathItem = all.body.data.items.find((s) => s.id === math.id);
    expect(mathItem).toMatchObject({ topicCount: 3, completedTopicCount: 1 });
    expect(all.body.data.items.find((s) => s.id === art.id)).toMatchObject({
      topicCount: 0,
      completedTopicCount: 0,
    });

    const archived = await api('get', '/subjects?archived=true', token);
    expect(archived.body.data.items.map((s) => s.name)).toEqual(['Art History']);

    const active = await api('get', '/subjects?archived=false', token);
    expect(active.body.data.items.map((s) => s.name)).toEqual(['Mathematics']);

    const byName = await api('get', '/subjects?search=art%20hist', token);
    expect(byName.body.data.items.map((s) => s.name)).toEqual(['Art History']);

    const byDescription = await api('get', '/subjects?search=ALGEBRA', token);
    expect(byDescription.body.data.items.map((s) => s.name)).toEqual(['Mathematics']);

    // Regex characters are matched literally.
    const regex = await api('get', '/subjects?search=.*', token);
    expect(regex.body.data.total).toBe(0);

    const page = await api('get', '/subjects?limit=1&page=2', token);
    expect(page.body.data).toMatchObject({ page: 2, limit: 1, total: 2 });
    expect(page.body.data.items).toHaveLength(1);

    expect((await api('get', '/subjects?archived=maybe', token)).status).toBe(400);
    expect((await api('get', '/subjects?limit=1000', token)).status).toBe(400);
  });

  it('gets and updates a subject', async () => {
    const { token } = await registerUser();
    const subject = await createSubject(token);

    const got = await api('get', `/subjects/${subject.id}`, token);
    expect(got.status).toBe(200);
    expect(got.body.data.subject.id).toBe(subject.id);

    const patched = await api('patch', `/subjects/${subject.id}`, token, {
      archived: true,
      color: null,
    });
    expect(patched.status).toBe(200);
    expect(patched.body.data.subject).toMatchObject({ archived: true, color: null });

    expect((await api('patch', `/subjects/${subject.id}`, token, {})).status).toBe(400);
  });

  it('does not expose other users data (404, not 403)', async () => {
    const { alice, bob } = await twoUsers();
    const subject = await createSubject(alice.token);

    expect((await api('get', `/subjects/${subject.id}`, bob.token)).status).toBe(404);
    expect(
      (await api('patch', `/subjects/${subject.id}`, bob.token, { name: 'Hacked' })).status,
    ).toBe(404);
    expect((await api('delete', `/subjects/${subject.id}`, bob.token)).status).toBe(404);

    const list = await api('get', '/subjects', bob.token);
    expect(list.body.data.total).toBe(0);

    expect(await Subject.findById(subject.id)).toMatchObject({ name: 'Mathematics' });
  });

  it('returns 404 for an unknown subject', async () => {
    const { token } = await registerUser();
    const res = await api('get', `/subjects/${someId()}`, token);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('SUBJECT_NOT_FOUND');
  });
});

describe('topics', () => {
  it('creates topics appended in order with defaults', async () => {
    const { token, id } = await registerUser();
    const subject = await createSubject(token);

    const first = await api('post', `/subjects/${subject.id}/topics`, token, { title: 'One' });
    expect(first.status).toBe(201);
    expect(first.body.data.topic).toMatchObject({
      title: 'One',
      order: 1,
      status: 'not_started',
      difficulty: 'medium',
      subject: subject.id,
      user: id,
    });

    const second = await createTopic(token, subject.id, 'Two', { difficulty: 'hard' });
    expect(second).toMatchObject({ order: 2, difficulty: 'hard' });

    const list = await api('get', `/subjects/${subject.id}/topics`, token);
    expect(list.body.data.items.map((t) => t.title)).toEqual(['One', 'Two']);
    expect(list.body.data).toMatchObject({ page: 1, limit: 20, total: 2 });
  });

  it('validates input', async () => {
    const { token } = await registerUser();
    const subject = await createSubject(token);
    const url = `/subjects/${subject.id}/topics`;
    expect((await api('post', url, token, {})).status).toBe(400);
    expect((await api('post', url, token, { title: 'x', status: 'done' })).status).toBe(400);
    expect((await api('post', url, token, { title: 'x', difficulty: 'insane' })).status).toBe(400);
    expect((await api('get', `${url}?status=bad`, token)).status).toBe(400);
  });

  it('filters by status and difficulty', async () => {
    const { token } = await registerUser();
    const subject = await createSubject(token);
    await createTopic(token, subject.id, 'A', { difficulty: 'easy' });
    await createTopic(token, subject.id, 'B', { status: 'in_progress' });

    const byStatus = await api('get', `/subjects/${subject.id}/topics?status=in_progress`, token);
    expect(byStatus.body.data.items.map((t) => t.title)).toEqual(['B']);
    const byDifficulty = await api('get', `/subjects/${subject.id}/topics?difficulty=easy`, token);
    expect(byDifficulty.body.data.items.map((t) => t.title)).toEqual(['A']);
  });

  it('gets, updates and transitions status freely via PATCH', async () => {
    const { token } = await registerUser();
    const subject = await createSubject(token);
    const topic = await createTopic(token, subject.id);

    for (const status of ['in_progress', 'completed', 'not_started']) {
      const res = await api('patch', `/topics/${topic.id}`, token, { status });
      expect(res.status).toBe(200);
      expect(res.body.data.topic.status).toBe(status);
    }

    const renamed = await api('patch', `/topics/${topic.id}`, token, {
      title: 'Renamed',
      difficulty: 'easy',
    });
    expect(renamed.body.data.topic).toMatchObject({ title: 'Renamed', difficulty: 'easy' });

    expect((await api('get', `/topics/${topic.id}`, token)).body.data.topic.title).toBe('Renamed');
    expect((await api('patch', `/topics/${topic.id}`, token, {})).status).toBe(400);
  });

  describe('reorder', () => {
    const setup = async () => {
      const { token } = await registerUser();
      const subject = await createSubject(token);
      const a = await createTopic(token, subject.id, 'A');
      const b = await createTopic(token, subject.id, 'B');
      const c = await createTopic(token, subject.id, 'C');
      return { token, subject, a, b, c };
    };
    const reorder = (token, subjectId, topicIds) =>
      api('patch', `/subjects/${subjectId}/topics/reorder`, token, { topicIds });

    it('applies the given order', async () => {
      const { token, subject, a, b, c } = await setup();
      const res = await reorder(token, subject.id, [c.id, a.id, b.id]);

      expect(res.status).toBe(200);
      expect(res.body.data.items.map((t) => t.title)).toEqual(['C', 'A', 'B']);
      expect(res.body.data.items.map((t) => t.order)).toEqual([1, 2, 3]);

      const list = await api('get', `/subjects/${subject.id}/topics`, token);
      expect(list.body.data.items.map((t) => t.title)).toEqual(['C', 'A', 'B']);

      // New topics go after the reordered ones.
      expect(await createTopic(token, subject.id, 'D')).toMatchObject({ order: 4 });
    });

    it('rejects lists that are incomplete, unknown or duplicated', async () => {
      const { token, subject, a, b, c } = await setup();

      const missing = await reorder(token, subject.id, [a.id, b.id]);
      expect(missing.status).toBe(400);
      expect(missing.body.error.code).toBe('INVALID_REORDER');
      expect(missing.body.error.details.missing).toEqual([c.id]);

      const unknownId = someId();
      const unknown = await reorder(token, subject.id, [a.id, b.id, c.id, unknownId]);
      expect(unknown.status).toBe(400);
      expect(unknown.body.error.details.unknown).toEqual([unknownId]);

      expect((await reorder(token, subject.id, [a.id, a.id, b.id, c.id])).status).toBe(400);
      expect((await reorder(token, subject.id, [])).status).toBe(400);
      expect((await reorder(token, subject.id, ['nope'])).status).toBe(400);

      // Nothing changed.
      const list = await api('get', `/subjects/${subject.id}/topics`, token);
      expect(list.body.data.items.map((t) => t.title)).toEqual(['A', 'B', 'C']);
    });

    it('rejects topics from another subject', async () => {
      const { token, subject, a, b, c } = await setup();
      const other = await createSubject(token, 'Other');
      const foreign = await createTopic(token, other.id, 'Foreign');

      const res = await reorder(token, subject.id, [a.id, b.id, foreign.id]);
      expect(res.status).toBe(400);
      expect(res.body.error.details).toEqual({ unknown: [foreign.id], missing: [c.id] });
    });

    it("cannot reorder or read another user's subject", async () => {
      const { alice, bob } = await twoUsers();
      const subject = await createSubject(alice.token);
      const topic = await createTopic(alice.token, subject.id);

      expect((await reorder(bob.token, subject.id, [topic.id])).status).toBe(404);
    });
  });

  it('isolates topics between users on every endpoint', async () => {
    const { alice, bob } = await twoUsers();
    const subject = await createSubject(alice.token);
    const topic = await createTopic(alice.token, subject.id);

    const attempts = [
      api('post', `/subjects/${subject.id}/topics`, bob.token, { title: 'Sneaky' }),
      api('get', `/subjects/${subject.id}/topics`, bob.token),
      api('get', `/topics/${topic.id}`, bob.token),
      api('patch', `/topics/${topic.id}`, bob.token, { title: 'Hacked' }),
      api('delete', `/topics/${topic.id}`, bob.token),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.status).toBe(404);
    }

    expect(await Topic.countDocuments({ subject: subject.id })).toBe(1);
    expect(await Topic.findById(topic.id)).toMatchObject({ title: 'Derivatives' });
  });

  it('404s when the topic belongs to the user but its subject does not', async () => {
    const { alice, bob } = await twoUsers();
    const subject = await createSubject(alice.token);
    const topic = await createTopic(alice.token, subject.id);
    // Corrupt ownership of the parent to simulate a mismatch.
    await Subject.updateOne({ _id: subject.id }, { user: bob.id });

    expect((await api('get', `/topics/${topic.id}`, alice.token)).status).toBe(404);
  });
});

describe('materials', () => {
  const setup = async () => {
    const { token } = await registerUser();
    const subject = await createSubject(token);
    const topic = await createTopic(token, subject.id);
    return { token, subject, topic };
  };
  const post = (token, topicId, body) => api('post', `/topics/${topicId}/materials`, token, body);

  it('creates a note, a link and a file', async () => {
    const { token, topic } = await setup();

    const note = await post(token, topic.id, {
      type: 'note',
      title: 'Chain rule',
      content: 'f(g(x))′ = f′(g(x)) g′(x)',
      tags: ['calculus', ' rules ', 'calculus'],
    });
    expect(note.status).toBe(201);
    expect(note.body.data.material).toMatchObject({
      type: 'note',
      topic: topic.id,
      tags: ['calculus', 'rules'],
    });

    const link = await post(token, topic.id, {
      type: 'link',
      title: 'Khan',
      url: 'https://www.khanacademy.org/math',
    });
    expect(link.status).toBe(201);
    expect(link.body.data.material.url).toBe('https://www.khanacademy.org/math');
    expect(link.body.data.material.tags).toEqual([]);

    const file = await post(token, topic.id, {
      type: 'file',
      title: 'Slides',
      fileUrl: 'https://cdn.example.com/slides.pdf',
      mimeType: 'application/pdf',
    });
    expect(file.status).toBe(201);
    expect(file.body.data.material).toMatchObject({ mimeType: 'application/pdf' });
  });

  it('enforces the right fields for each type', async () => {
    const { token, topic } = await setup();
    const invalid = [
      { type: 'note', title: 'No content' },
      { type: 'note', title: 'Blank', content: '   ' },
      { type: 'note', title: 'Wrong field', url: 'https://example.com' },
      { type: 'link', title: 'No url' },
      { type: 'link', title: 'Bad url', url: 'not a url' },
      { type: 'link', title: 'Bad protocol', url: 'javascript:alert(1)' },
      { type: 'link', title: 'Wrong field', content: 'text' },
      { type: 'file', title: 'No file url', mimeType: 'application/pdf' },
      { type: 'file', title: 'No mime', fileUrl: 'https://cdn.example.com/a.pdf' },
      {
        type: 'file',
        title: 'Bad mime',
        fileUrl: 'https://cdn.example.com/a.pdf',
        mimeType: 'pdf',
      },
      { type: 'file', title: 'Bad file url', fileUrl: 'nope', mimeType: 'application/pdf' },
      { type: 'video', title: 'Unknown type', url: 'https://example.com' },
      { title: 'Missing type', content: 'x' },
      { type: 'note', content: 'No title' },
    ];

    for (const body of invalid) {
      const res = await post(token, topic.id, body);
      expect([body, res.status]).toEqual([body, 400]);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect(await Material.countDocuments()).toBe(0);
  });

  it('strips fields that do not belong to the type', async () => {
    const { token, topic } = await setup();
    const res = await post(token, topic.id, {
      type: 'note',
      title: 'Note',
      content: 'text',
      url: 'https://example.com',
      mimeType: 'application/pdf',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.material.url).toBeUndefined();
    expect(res.body.data.material.mimeType).toBeUndefined();
  });

  it('lists, filters by type and paginates', async () => {
    const { token, topic } = await setup();
    await createNote(token, topic.id, 'n1');
    await createNote(token, topic.id, 'n2');
    await post(token, topic.id, { type: 'link', title: 'l1', url: 'https://example.com' });

    const all = await api('get', `/topics/${topic.id}/materials`, token);
    expect(all.body.data).toMatchObject({ page: 1, limit: 20, total: 3 });

    const links = await api('get', `/topics/${topic.id}/materials?type=link`, token);
    expect(links.body.data.items.map((m) => m.title)).toEqual(['l1']);

    const paged = await api('get', `/topics/${topic.id}/materials?limit=2&page=2`, token);
    expect(paged.body.data.items).toHaveLength(1);
    expect(paged.body.data.total).toBe(3);

    expect((await api('get', `/topics/${topic.id}/materials?type=video`, token)).status).toBe(400);
  });

  it('gets, updates and deletes a material', async () => {
    const { token, topic } = await setup();
    const note = await createNote(token, topic.id);

    expect((await api('get', `/materials/${note.id}`, token)).body.data.material.id).toBe(note.id);

    const patched = await api('patch', `/materials/${note.id}`, token, {
      title: 'Renamed',
      content: 'Updated',
      tags: ['x'],
    });
    expect(patched.status).toBe(200);
    expect(patched.body.data.material).toMatchObject({
      title: 'Renamed',
      content: 'Updated',
      tags: ['x'],
      type: 'note',
    });

    const del = await api('delete', `/materials/${note.id}`, token);
    expect(del.status).toBe(200);
    expect((await api('get', `/materials/${note.id}`, token)).status).toBe(404);
  });

  it('keeps per-type rules on PATCH', async () => {
    const { token, topic } = await setup();
    const link = (
      await post(token, topic.id, { type: 'link', title: 'Link', url: 'https://example.com' })
    ).body.data.material;

    const badUrl = await api('patch', `/materials/${link.id}`, token, { url: 'nope' });
    expect(badUrl.status).toBe(400);

    const wrongField = await api('patch', `/materials/${link.id}`, token, { content: 'text' });
    expect(wrongField.status).toBe(400);
    expect(wrongField.body.error.details[0].field).toBe('content');

    const changeType = await api('patch', `/materials/${link.id}`, token, { type: 'note' });
    expect(changeType.status).toBe(400);
    expect(changeType.body.error.code).toBe('MATERIAL_TYPE_IMMUTABLE');

    const sameType = await api('patch', `/materials/${link.id}`, token, {
      type: 'link',
      url: 'https://example.org',
    });
    expect(sameType.status).toBe(200);
    expect(sameType.body.data.material.url).toBe('https://example.org');

    expect((await api('patch', `/materials/${link.id}`, token, {})).status).toBe(400);
  });

  it('isolates materials between users on every endpoint', async () => {
    const { alice, bob } = await twoUsers();
    const subject = await createSubject(alice.token);
    const topic = await createTopic(alice.token, subject.id);
    const note = await createNote(alice.token, topic.id);

    const attempts = [
      post(bob.token, topic.id, { type: 'note', title: 'Sneaky', content: 'x' }),
      api('get', `/topics/${topic.id}/materials`, bob.token),
      api('get', `/materials/${note.id}`, bob.token),
      api('patch', `/materials/${note.id}`, bob.token, { title: 'Hacked' }),
      api('delete', `/materials/${note.id}`, bob.token),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.status).toBe(404);
    }
    expect(await Material.countDocuments()).toBe(1);
    expect(await Material.findById(note.id)).toMatchObject({ title: 'My note' });
  });
});

describe('cascade delete', () => {
  const build = async (token, name) => {
    const subject = await createSubject(token, name);
    const t1 = await createTopic(token, subject.id, 'T1');
    const t2 = await createTopic(token, subject.id, 'T2');
    await createNote(token, t1.id);
    await createNote(token, t1.id);
    await createNote(token, t2.id);
    await createLesson(token, t1.id);
    await createLesson(token, t2.id);
    return { subject, t1, t2 };
  };

  it('deleting a subject removes its topics, materials and lessons only', async () => {
    const { alice, bob } = await twoUsers();
    const doomed = await build(alice.token, 'Doomed');
    await build(alice.token, 'Survivor');
    await build(bob.token, 'Doomed');

    const res = await api('delete', `/subjects/${doomed.subject.id}`, alice.token);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      id: doomed.subject.id,
      deleted: {
        topics: 2,
        lessons: 2,
        materials: 3,
        mistakes: 0,
        attempts: 0,
        quizzes: 0,
        flashcards: 0,
      },
    });

    expect(await Subject.findById(doomed.subject.id)).toBeNull();
    expect(await Topic.countDocuments({ subject: doomed.subject.id })).toBe(0);
    expect(await Material.countDocuments({ topic: { $in: [doomed.t1.id, doomed.t2.id] } })).toBe(0);
    expect(await Lesson.countDocuments({ topic: { $in: [doomed.t1.id, doomed.t2.id] } })).toBe(0);

    // Alice's other subject and Bob's data are untouched.
    expect(await Subject.countDocuments()).toBe(2);
    expect(await Topic.countDocuments()).toBe(4);
    expect(await Material.countDocuments()).toBe(6);
    expect(await Lesson.countDocuments()).toBe(4);
  });

  it('deleting a topic removes its materials and lesson only', async () => {
    const { token } = await registerUser();
    const { subject, t1, t2 } = await build(token, 'Subject');

    const res = await api('delete', `/topics/${t1.id}`, token);
    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toEqual({
      lessons: 1,
      materials: 2,
      mistakes: 0,
      attempts: 0,
      quizzes: 0,
      flashcards: 0,
    });

    expect(await Topic.findById(t1.id)).toBeNull();
    expect(await Material.countDocuments({ topic: t1.id })).toBe(0);
    expect(await Lesson.countDocuments({ topic: t1.id })).toBe(0);
    expect(await Topic.findById(t2.id)).not.toBeNull();
    expect(await Material.countDocuments({ topic: t2.id })).toBe(1);
    expect(await Lesson.countDocuments({ topic: t2.id })).toBe(1);
    expect(await Subject.findById(subject.id)).not.toBeNull();
  });

  it('deleting a subject with no topics works', async () => {
    const { token } = await registerUser();
    const subject = await createSubject(token);
    const res = await api('delete', `/subjects/${subject.id}`, token);
    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toEqual({
      topics: 0,
      lessons: 0,
      materials: 0,
      mistakes: 0,
      attempts: 0,
      quizzes: 0,
      flashcards: 0,
    });
  });

  it('keeps the subject when a child delete fails, so the request can be retried', async () => {
    const { token } = await registerUser();
    const { subject } = await build(token, 'Flaky');

    const spy = jest.spyOn(Material, 'deleteMany').mockRejectedValueOnce(new Error('boom'));
    const failed = await api('delete', `/subjects/${subject.id}`, token);
    expect(failed.status).toBe(500);
    expect(failed.body.error.code).toBe('CASCADE_DELETE_FAILED');
    expect(failed.body.error.message).not.toMatch(/boom/);
    expect(spy).toHaveBeenCalledTimes(1);

    // Children are deleted before the parent, so the subject is still there.
    expect(await Subject.findById(subject.id)).not.toBeNull();

    const retry = await api('delete', `/subjects/${subject.id}`, token);
    expect(retry.status).toBe(200);
    expect(await Subject.countDocuments()).toBe(0);
    expect(await Topic.countDocuments()).toBe(0);
    expect(await Material.countDocuments()).toBe(0);
    expect(await Lesson.countDocuments()).toBe(0);
  });
});
