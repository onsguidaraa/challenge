import request from 'supertest';
import app from '../src/app.js';
import { Mistake } from '../src/modules/mistakes/mistakes.model.js';
import { Profile } from '../src/modules/profile/profile.model.js';
import { startTestDb, clearTestDb, stopTestDb } from './helpers/db.js';
import { API, registerUser } from './helpers/auth.js';
import { api, createSubject, createTopic } from './helpers/space.js';
import { sampleQuiz, createQuiz, submit, answerAll, answerSet } from './helpers/practice.js';

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

const setup = async (email = 'ada@example.com') => {
  const user = await registerUser(email);
  const subject = await createSubject(user.token);
  const topic = await createTopic(user.token, subject.id);
  const quiz = await createQuiz(user.token, topic.id);
  return { ...user, subject, topic, quiz };
};

/** Submits all three questions; `right[i]` picks the right or the wrong answer. */
const attempt = (token, quiz, right) => submit(token, quiz.id, answerAll(quiz, right));

const mistakeFor = (user, quiz, index) =>
  Mistake.findOne({ user, quiz: quiz.id, questionId: quiz.questions[index].id });

describe('authentication and ids', () => {
  it.each([
    ['get', '/mistakes'],
    ['get', '/mistakes/weak-topics'],
    ['post', '/mistakes/practice'],
    ['get', `/mistakes/${fakeId}`],
    ['patch', `/mistakes/${fakeId}/resolve`],
    ['patch', `/mistakes/${fakeId}/unresolve`],
  ])('%s %s requires authentication', async (method, path) => {
    const res = await request(app)[method](`${API}${path}`);
    expect(res.status).toBe(401);
  });

  it('rejects malformed ids and filters, 404 for unknown ids', async () => {
    const { token } = await registerUser();
    expect((await api('get', '/mistakes/nope', token)).status).toBe(400);
    expect((await api('patch', '/mistakes/nope/resolve', token)).status).toBe(400);
    expect((await api('get', '/mistakes?topic=nope', token)).status).toBe(400);
    expect((await api('get', '/mistakes?resolved=maybe', token)).status).toBe(400);
    expect((await api('post', '/mistakes/practice', token, { limit: 0 })).status).toBe(400);
    expect((await api('get', `/mistakes/${fakeId}`, token)).status).toBe(404);
  });
});

describe('Mistake Notebook, recorded on submit', () => {
  it('creates a Mistake for a wrong answer and none for right answers', async () => {
    const { token, id, topic, quiz } = await setup();
    await attempt(token, quiz, [true, false, true]);

    const mistakes = await Mistake.find({ user: id });
    expect(mistakes).toHaveLength(1);
    expect(mistakes[0]).toMatchObject({
      topic: expect.anything(),
      questionPrompt: 'The derivative of a constant is 0.',
      userAnswer: 'false',
      correctAnswer: 'true',
      explanation: 'Constants do not change.',
      retryCount: 0,
      correctStreak: 0,
      resolved: false,
      resolvedAt: null,
    });
    expect(String(mistakes[0].topic)).toBe(topic.id);
    expect(String(mistakes[0].quiz)).toBe(quiz.id);
    expect(String(mistakes[0].questionId)).toBe(quiz.questions[1].id);
    expect(mistakes[0].lastAttemptedAt).toBeInstanceOf(Date);
  });

  it('reports what happened to the notebook in the submit response', async () => {
    const { token, quiz } = await setup();
    const first = await attempt(token, quiz, [false, false, true]);
    expect(first.body.data.mistakes).toEqual({ created: 2, repeated: 0, resolved: 0 });

    const second = await attempt(token, quiz, [false, true, true]);
    expect(second.body.data.mistakes).toEqual({ created: 0, repeated: 1, resolved: 0 });
  });

  it('stores the short-answer accepted answers as the correct answer', async () => {
    const { token, id, quiz } = await setup();
    await attempt(token, quiz, [true, true, false]);
    expect((await mistakeFor(id, quiz, 2)).correctAnswer).toEqual(['product rule', 'leibniz rule']);
  });

  it('does not duplicate on a retry: it updates the answer and increments retryCount', async () => {
    const { token, id, quiz } = await setup();
    await submit(token, quiz.id, answerSet(quiz, [[0, 'x']]));
    await submit(token, quiz.id, answerSet(quiz, [[0, 'x^2']]));

    expect(await Mistake.countDocuments({ user: id })).toBe(1);
    expect(await mistakeFor(id, quiz, 0)).toMatchObject({ retryCount: 1, userAnswer: 'x^2' });

    await submit(token, quiz.id, answerSet(quiz, [[0, 'x']]));
    expect(await Mistake.countDocuments({ user: id })).toBe(1);
    expect(await mistakeFor(id, quiz, 0)).toMatchObject({ retryCount: 2, userAnswer: 'x' });
  });

  it('does not duplicate when two wrong submits arrive at the same time', async () => {
    const { token, id, quiz } = await setup();
    const answers = answerSet(quiz, [[0, 'x']]);
    const results = await Promise.all([
      submit(token, quiz.id, answers),
      submit(token, quiz.id, answers),
    ]);

    expect(results.map((r) => r.status)).toEqual([201, 201]);
    expect(await Mistake.countDocuments({ user: id })).toBe(1);
    expect((await mistakeFor(id, quiz, 0)).retryCount).toBe(1);
  });

  it('keeps separate mistakes for the same wrong question text in different quizzes', async () => {
    const { token, id, topic, quiz } = await setup();
    const other = await createQuiz(token, topic.id, { ...sampleQuiz, title: 'Copy' });
    await attempt(token, quiz, [false, true, true]);
    await attempt(token, other, [false, true, true]);
    expect(await Mistake.countDocuments({ user: id })).toBe(2);
  });

  it('leaves unanswered questions out of the notebook, and keeps an existing streak', async () => {
    const { token, id, quiz } = await setup();
    await attempt(token, quiz, [false, true, true]);
    await attempt(token, quiz, [true, true, true]); // streak 1

    await submit(token, quiz.id, answerSet(quiz, [[1, 'true']])); // question 0 skipped
    expect(await mistakeFor(id, quiz, 0)).toMatchObject({ correctStreak: 1, resolved: false });
    expect(await Mistake.countDocuments({ user: id })).toBe(1);
  });

  describe('auto-resolve after consecutive correct answers', () => {
    it('increments correctStreak and resolves on the second correct answer in a row', async () => {
      const { token, id, quiz } = await setup();
      await attempt(token, quiz, [false, true, true]);

      await attempt(token, quiz, [true, true, true]);
      expect(await mistakeFor(id, quiz, 0)).toMatchObject({
        correctStreak: 1,
        resolved: false,
        resolvedAt: null,
      });

      const res = await attempt(token, quiz, [true, true, true]);
      expect(res.body.data.mistakes.resolved).toBe(1);
      const resolved = await mistakeFor(id, quiz, 0);
      expect(resolved).toMatchObject({ correctStreak: 2, resolved: true, retryCount: 0 });
      expect(resolved.resolvedAt).toBeInstanceOf(Date);

      // Further correct answers leave a resolved mistake alone.
      const resolvedAt = resolved.resolvedAt;
      await attempt(token, quiz, [true, true, true]);
      const after = await mistakeFor(id, quiz, 0);
      expect(after).toMatchObject({ correctStreak: 2, resolved: true });
      expect(after.resolvedAt.getTime()).toBe(resolvedAt.getTime());
    });

    it('resets the streak when a wrong answer interrupts it', async () => {
      const { token, id, quiz } = await setup();
      await attempt(token, quiz, [false, true, true]);
      await attempt(token, quiz, [true, true, true]); // streak 1
      await attempt(token, quiz, [false, true, true]); // wrong again

      expect(await mistakeFor(id, quiz, 0)).toMatchObject({
        correctStreak: 0,
        resolved: false,
        retryCount: 1,
      });

      await attempt(token, quiz, [true, true, true]);
      expect((await mistakeFor(id, quiz, 0)).resolved).toBe(false);
      await attempt(token, quiz, [true, true, true]);
      expect((await mistakeFor(id, quiz, 0)).resolved).toBe(true);
    });

    it('reopens a resolved mistake when the question is answered wrong again', async () => {
      const { token, id, quiz } = await setup();
      await attempt(token, quiz, [false, true, true]);
      await attempt(token, quiz, [true, true, true]);
      await attempt(token, quiz, [true, true, true]);
      expect((await mistakeFor(id, quiz, 0)).resolved).toBe(true);

      await attempt(token, quiz, [false, true, true]);
      expect(await mistakeFor(id, quiz, 0)).toMatchObject({
        resolved: false,
        resolvedAt: null,
        correctStreak: 0,
        retryCount: 1,
      });
    });

    it('never creates a mistake for questions that were always right', async () => {
      const { token, id, quiz } = await setup();
      await attempt(token, quiz, [true, true, true]);
      await attempt(token, quiz, [true, true, true]);
      expect(await Mistake.countDocuments({ user: id })).toBe(0);
    });
  });
});

describe('GET /mistakes', () => {
  const build = async () => {
    const ctx = await setup();
    const topicB = await createTopic(ctx.token, ctx.subject.id, 'Integrals');
    const quizB = await createQuiz(ctx.token, topicB.id);
    const subject2 = await createSubject(ctx.token, 'Physics');
    const topicC = await createTopic(ctx.token, subject2.id, 'Forces');
    const quizC = await createQuiz(ctx.token, topicC.id);

    await attempt(ctx.token, ctx.quiz, [false, false, true]); // A: 2
    await attempt(ctx.token, quizB, [false, true, true]); // B: 1
    await attempt(ctx.token, quizC, [false, false, false]); // C: 3
    return { ...ctx, topicB, quizB, subject2, topicC, quizC };
  };

  it('lists, newest activity first, with the standard pagination shape', async () => {
    const { token } = await build();
    const res = await api('get', '/mistakes?limit=4', token);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ page: 1, limit: 4, total: 6 });
    expect(res.body.data.items).toHaveLength(4);
    expect(res.body.data.items[0]).toHaveProperty('correctAnswer');
    expect(res.body.data.items[0]).toHaveProperty('explanation');

    const page2 = await api('get', '/mistakes?limit=4&page=2', token);
    expect(page2.body.data.items).toHaveLength(2);
    const ids = [...res.body.data.items, ...page2.body.data.items].map((m) => m.id);
    expect(new Set(ids).size).toBe(6);
  });

  it('filters by topic, by subject and by resolved', async () => {
    const { token, topic, topicB, subject, subject2, topicC } = await build();

    const byTopic = await api('get', `/mistakes?topic=${topicB.id}`, token);
    expect(byTopic.body.data.total).toBe(1);
    expect(byTopic.body.data.items[0].topic).toBe(topicB.id);

    const bySubject = await api('get', `/mistakes?subject=${subject.id}`, token);
    expect(bySubject.body.data.total).toBe(3);

    const bySubject2 = await api('get', `/mistakes?subject=${subject2.id}`, token);
    expect(bySubject2.body.data.total).toBe(3);
    expect(bySubject2.body.data.items.every((m) => m.topic === topicC.id)).toBe(true);

    // Topic and subject together: the topic has to belong to the subject.
    const both = await api('get', `/mistakes?subject=${subject.id}&topic=${topic.id}`, token);
    expect(both.body.data.total).toBe(2);
    const mismatch = await api('get', `/mistakes?subject=${subject2.id}&topic=${topic.id}`, token);
    expect(mismatch.body.data.total).toBe(0);

    const first = (await api('get', `/mistakes?topic=${topic.id}`, token)).body.data.items[0];
    await api('patch', `/mistakes/${first.id}/resolve`, token);
    const resolved = await api('get', '/mistakes?resolved=true', token);
    expect(resolved.body.data.items.map((m) => m.id)).toEqual([first.id]);
    expect((await api('get', '/mistakes?resolved=false', token)).body.data.total).toBe(5);
  });

  it("never lists another user's mistakes, even when filtering by their topic", async () => {
    const { token, topic } = await build();
    const other = await registerUser('grace@example.com');

    expect((await api('get', '/mistakes', other.token)).body.data.total).toBe(0);
    expect((await api('get', `/mistakes?topic=${topic.id}`, other.token)).body.data.total).toBe(0);
    expect((await api('get', '/mistakes', token)).body.data.total).toBe(6);
  });
});

describe('GET /mistakes/:id and resolve / unresolve', () => {
  it('returns one mistake, and resolves and reopens it by hand', async () => {
    const { token, id, quiz } = await setup();
    await attempt(token, quiz, [false, true, true]);
    await attempt(token, quiz, [true, true, true]); // streak 1
    const doc = await mistakeFor(id, quiz, 0);

    const read = await api('get', `/mistakes/${doc.id}`, token);
    expect(read.status).toBe(200);
    expect(read.body.data.mistake).toMatchObject({
      id: doc.id,
      quiz: quiz.id,
      questionId: quiz.questions[0].id,
      resolved: false,
      correctStreak: 1,
    });

    const resolved = await api('patch', `/mistakes/${doc.id}/resolve`, token);
    expect(resolved.status).toBe(200);
    expect(resolved.body.data.mistake.resolved).toBe(true);
    expect(resolved.body.data.mistake.resolvedAt).not.toBeNull();

    const again = await api('patch', `/mistakes/${doc.id}/resolve`, token);
    expect(again.status).toBe(200);
    expect(again.body.data.mistake.resolvedAt).toBe(resolved.body.data.mistake.resolvedAt);

    const reopened = await api('patch', `/mistakes/${doc.id}/unresolve`, token);
    expect(reopened.body.data.mistake).toMatchObject({
      resolved: false,
      resolvedAt: null,
      correctStreak: 0,
    });
  });

  it('returns 404 for another user and changes nothing', async () => {
    const { token, id, quiz } = await setup();
    await attempt(token, quiz, [false, true, true]);
    const doc = await mistakeFor(id, quiz, 0);
    const other = await registerUser('grace@example.com');

    expect((await api('get', `/mistakes/${doc.id}`, other.token)).status).toBe(404);
    expect((await api('patch', `/mistakes/${doc.id}/resolve`, other.token)).status).toBe(404);
    expect((await api('patch', `/mistakes/${doc.id}/unresolve`, other.token)).status).toBe(404);
    expect((await Mistake.findById(doc.id)).resolved).toBe(false);
  });
});

describe('POST /mistakes/practice', () => {
  it('returns unresolved mistakes as quiz-like questions without answers', async () => {
    const { token, id, topic, quiz } = await setup();
    await attempt(token, quiz, [false, false, false]);
    const resolvedDoc = await mistakeFor(id, quiz, 1);
    await api('patch', `/mistakes/${resolvedDoc.id}/resolve`, token);

    const res = await api('post', '/mistakes/practice', token, {});
    expect(res.status).toBe(200);
    const { practice } = res.body.data;
    expect(practice.total).toBe(2);
    expect(practice.questions.map((q) => q.questionId).sort()).toEqual(
      [quiz.questions[0].id, quiz.questions[2].id].sort(),
    );
    expect(practice.questions[0]).toMatchObject({ quizId: quiz.id, topicId: topic.id });

    const mcq = practice.questions.find((q) => q.type === 'mcq');
    expect(mcq).toMatchObject({
      prompt: 'What is d/dx of x^2?',
      options: ['x', '2x', 'x^2'],
      points: 1,
    });

    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('correctAnswer');
    expect(raw).not.toContain('explanation');
    expect(raw).not.toContain('Power rule');
  });

  it('works without a body, respects limit and topic, and ignores other users', async () => {
    const { token, subject, quiz } = await setup();
    const topicB = await createTopic(token, subject.id, 'Integrals');
    const quizB = await createQuiz(token, topicB.id);
    await attempt(token, quiz, [false, false, false]);
    await attempt(token, quizB, [false, true, true]);

    const bare = await request(app)
      .post(`${API}/mistakes/practice`)
      .set('Authorization', `Bearer ${token}`);
    expect(bare.status).toBe(200);
    expect(bare.body.data.practice.total).toBe(4);

    const limited = await api('post', '/mistakes/practice', token, { limit: 2 });
    expect(limited.body.data.practice.questions).toHaveLength(2);

    const byTopic = await api('post', '/mistakes/practice', token, { topic: topicB.id });
    expect(byTopic.body.data.practice.questions.map((q) => q.quizId)).toEqual([quizB.id]);

    const bySubject = await api('post', '/mistakes/practice', token, { subject: subject.id });
    expect(bySubject.body.data.practice.total).toBe(4);

    const other = await registerUser('grace@example.com');
    const empty = await api('post', '/mistakes/practice', other.token, {});
    expect(empty.body.data.practice).toMatchObject({ total: 0, questions: [] });
  });

  it('can be answered through the quiz submit flow, which updates the notebook', async () => {
    const { token, id, quiz } = await setup();
    await attempt(token, quiz, [false, true, true]);

    const { practice } = (await api('post', '/mistakes/practice', token, {})).body.data;
    const [q] = practice.questions;
    const retry = () => submit(token, q.quizId, [{ questionId: q.questionId, answer: '2x' }]);

    await retry();
    await retry();
    expect(await mistakeFor(id, quiz, 0)).toMatchObject({ resolved: true, correctStreak: 2 });
    expect((await api('post', '/mistakes/practice', token, {})).body.data.practice.total).toBe(0);
  });
});

describe('GET /mistakes/weak-topics', () => {
  it('ranks topics by unresolved mistakes, with subject info and a suggested action', async () => {
    const { token, subject, topic, quiz } = await setup();
    const topicB = await createTopic(token, subject.id, 'Integrals');
    const quizB = await createQuiz(token, topicB.id);
    const subject2 = await createSubject(token, 'Physics', { color: '#112233' });
    const topicC = await createTopic(token, subject2.id, 'Forces');
    const quizC = await createQuiz(token, topicC.id);
    const topicD = await createTopic(token, subject2.id, 'Energy');
    const quizD = await createQuiz(token, topicD.id);

    await attempt(token, quiz, [false, false, true]); // A: 2 unresolved
    await attempt(token, quizB, [false, true, true]); // B: 1
    await attempt(token, quizC, [false, false, false]); // C: 3
    await attempt(token, quizD, [false, true, true]); // D: 1, resolved below
    const dMistake = await Mistake.findOne({ quiz: quizD.id });
    await api('patch', `/mistakes/${dMistake.id}/resolve`, token);

    const res = await api('get', '/mistakes/weak-topics', token);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ page: 1, limit: 20, total: 3 });

    const items = res.body.data.items;
    expect(items.map((i) => [i.topic.title, i.unresolvedCount])).toEqual([
      ['Forces', 3],
      ['Derivatives', 2],
      ['Integrals', 1],
    ]);
    expect(items[0]).toMatchObject({
      topic: { id: topicC.id, title: 'Forces' },
      subject: { id: subject2.id, name: 'Physics', color: '#112233' },
      suggestedAction: { type: 'practice_mistakes', topicId: topicC.id },
    });
    expect(items[0].suggestedAction.message).toEqual(expect.any(String));
    expect(items[1].subject).toMatchObject({ id: subject.id, name: 'Mathematics' });
    expect(items[1].topic.id).toBe(topic.id);
    expect(items[2].suggestedAction.message).toMatch(/retry/i);
  });

  it('suggests reviewing the lesson when a topic has many unresolved mistakes', async () => {
    const { token, topic, quiz } = await setup();
    const many = await createQuiz(token, topic.id, {
      title: 'Many',
      questions: Array.from({ length: 5 }, (_v, i) => ({
        type: 'true_false',
        prompt: `Statement ${i}`,
        correctAnswer: true,
        explanation: 'It is true.',
      })),
    });
    await submit(
      token,
      many.id,
      many.questions.map((q) => ({ questionId: q.id, answer: false })),
    );
    await attempt(token, quiz, [false, true, true]);

    const { items } = (await api('get', '/mistakes/weak-topics', token)).body.data;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      unresolvedCount: 6,
      suggestedAction: { type: 'review_lesson' },
    });
  });

  it('paginates, drops a topic once all its mistakes are resolved, and is scoped to the user', async () => {
    const { token, subject, quiz } = await setup();
    const topicB = await createTopic(token, subject.id, 'Integrals');
    const quizB = await createQuiz(token, topicB.id);
    await attempt(token, quiz, [false, false, true]);
    await attempt(token, quizB, [false, true, true]);

    const page2 = await api('get', '/mistakes/weak-topics?limit=1&page=2', token);
    expect(page2.body.data).toMatchObject({ page: 2, limit: 1, total: 2 });
    expect(page2.body.data.items.map((i) => i.topic.title)).toEqual(['Integrals']);

    const other = await registerUser('grace@example.com');
    expect((await api('get', '/mistakes/weak-topics', other.token)).body.data).toMatchObject({
      total: 0,
      items: [],
    });

    const only = await Mistake.findOne({ quiz: quizB.id });
    await api('patch', `/mistakes/${only.id}/resolve`, token);
    const after = await api('get', '/mistakes/weak-topics', token);
    expect(after.body.data.items.map((i) => i.topic.title)).toEqual(['Derivatives']);
  });
});

describe('profile.learnedStats.weakTopics', () => {
  it('is updated after a submit, ranked by unresolved mistakes, and follows resolve changes', async () => {
    const { token, id, subject, topic, quiz } = await setup();
    await Profile.create({ user: id, academicLevel: 'other' });
    const topicB = await createTopic(token, subject.id, 'Integrals');
    const quizB = await createQuiz(token, topicB.id);

    const weak = async () =>
      (await Profile.findOne({ user: id })).learnedStats.weakTopics.map(String);
    expect(await weak()).toEqual([]);

    await attempt(token, quizB, [false, true, true]);
    expect(await weak()).toEqual([topicB.id]);

    await attempt(token, quiz, [false, false, true]);
    expect(await weak()).toEqual([topic.id, topicB.id]);

    // Resolving every mistake of a topic drops it from the list.
    const mistakes = await Mistake.find({ user: id, topic: topic.id });
    for (const m of mistakes) await api('patch', `/mistakes/${m.id}/resolve`, token);
    expect(await weak()).toEqual([topicB.id]);

    await api('patch', `/mistakes/${mistakes[0].id}/unresolve`, token);
    // Tied on 1 each: the most recent mistake (topic) ranks first.
    expect(await weak()).toEqual([topic.id, topicB.id]);
  });

  it('does not make the submit fail when the user has no profile yet', async () => {
    const { token, quiz } = await setup();
    const res = await attempt(token, quiz, [false, false, false]);
    expect(res.status).toBe(201);
  });
});
