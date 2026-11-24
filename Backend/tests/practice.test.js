import request from 'supertest';

import app from '../src/app.js';
import { Quiz, Attempt } from '../src/modules/practice/practice.model.js';
import { isAnswerCorrect } from '../src/modules/practice/practice.service.js';
import { Mistake } from '../src/modules/mistakes/mistakes.model.js';
import { Lesson } from '../src/modules/lessons/lessons.model.js';
import { ActivityLog } from '../src/modules/activity-log/activity-log.model.js';
import { startTestDb, clearTestDb, stopTestDb } from './helpers/db.js';
import { API, registerUser } from './helpers/auth.js';
import { api, createSubject, createTopic, createLesson } from './helpers/space.js';
import { sampleQuiz, createQuiz, submit, answerSet, answerAll, RIGHT } from './helpers/practice.js';

beforeAll(async () => {
  await startTestDb();
}, 120000);

afterEach(async () => {
  await clearTestDb();
});

afterAll(async () => {
  await stopTestDb();
});

const setup = async (email = 'ada@example.com') => {
  const user = await registerUser(email);
  const subject = await createSubject(user.token);
  const topic = await createTopic(user.token, subject.id);
  const quiz = await createQuiz(user.token, topic.id);
  return { ...user, subject, topic, quiz };
};

const fakeId = '64b000000000000000000001';

describe('authentication and ids', () => {
  it.each([
    ['post', `/topics/${fakeId}/quizzes`],
    ['get', `/topics/${fakeId}/quizzes`],
    ['get', `/quizzes/${fakeId}`],
    ['get', `/quizzes/${fakeId}/edit`],
    ['patch', `/quizzes/${fakeId}`],
    ['delete', `/quizzes/${fakeId}`],
    ['post', `/quizzes/${fakeId}/submit`],
    ['get', `/quizzes/${fakeId}/attempts`],
    ['get', `/attempts/${fakeId}`],
  ])('%s %s requires authentication', async (method, path) => {
    const res = await request(app)[method](`${API}${path}`);
    expect(res.status).toBe(401);
  });

  it('rejects malformed ids with 400 and unknown ones with 404', async () => {
    const { token } = await registerUser();
    expect((await api('get', '/quizzes/nope', token)).status).toBe(400);
    expect((await api('get', '/attempts/nope', token)).status).toBe(400);
    expect((await api('get', '/topics/nope/quizzes', token)).status).toBe(400);
    expect((await api('get', `/quizzes/${fakeId}`, token)).status).toBe(404);
    expect((await api('get', `/attempts/${fakeId}`, token)).status).toBe(404);
    expect((await api('get', `/topics/${fakeId}/quizzes`, token)).status).toBe(404);
  });
});

describe('POST /topics/:topicId/quizzes', () => {
  it('creates a quiz with questions that have ids, defaults and the owner view', async () => {
    const { token, id, topic, quiz } = await setup();

    expect(quiz).toMatchObject({
      user: id,
      topic: topic.id,
      title: 'Derivatives quiz',
      timeLimitMinutes: null,
      questionCount: 3,
      totalPoints: 4,
    });
    expect(quiz.questions.map((q) => q.points)).toEqual([1, 1, 2]);
    expect(quiz.questions.every((q) => /^[a-f\d]{24}$/.test(q.id))).toBe(true);
    // true/false answers are normalized to strings.
    expect(quiz.questions[1].correctAnswer).toBe('true');
    expect(quiz.questions[0].correctAnswer).toBe('2x');

    const withLimit = await api('post', `/topics/${topic.id}/quizzes`, token, {
      ...sampleQuiz,
      timeLimitMinutes: 15,
    });
    expect(withLimit.status).toBe(201);
    expect(withLimit.body.data.quiz.timeLimitMinutes).toBe(15);
  });

  it('returns 404 for a topic of another user', async () => {
    const { topic } = await setup();
    const other = await registerUser('grace@example.com');
    const res = await api('post', `/topics/${topic.id}/quizzes`, other.token, sampleQuiz);
    expect(res.status).toBe(404);
  });

  describe('per-type validation', () => {
    const question = (overrides) => ({
      type: 'mcq',
      prompt: 'Pick one',
      options: ['a', 'b'],
      correctAnswer: 'a',
      explanation: 'Because.',
      ...overrides,
    });
    const create = async (token, topicId, q) =>
      api('post', `/topics/${topicId}/quizzes`, token, { title: 'T', questions: [q] });

    it.each([
      ['mcq with 1 option', question({ options: ['a'] })],
      ['mcq without options', question({ options: undefined })],
      ['mcq whose answer is not an option', question({ correctAnswer: 'z' })],
      ['mcq with duplicate options', question({ options: ['a', 'a'] })],
      ['mcq with an array answer', question({ correctAnswer: ['a'] })],
      [
        'true_false with another answer',
        { ...question({ type: 'true_false' }), correctAnswer: 'yes' },
      ],
      [
        'short_answer with no accepted answer',
        question({ type: 'short_answer', correctAnswer: [] }),
      ],
      ['short_answer with a blank answer', question({ type: 'short_answer', correctAnswer: '  ' })],
      ['missing explanation', question({ explanation: undefined })],
      ['blank explanation', question({ explanation: '   ' })],
      ['unknown type', question({ type: 'essay' })],
      ['zero points', question({ points: 0 })],
    ])('rejects %s', async (_name, q) => {
      const { token, topic } = await setup();
      const res = await create(token, topic.id, q);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects a quiz without questions', async () => {
      const { token, topic } = await setup();
      const res = await api('post', `/topics/${topic.id}/quizzes`, token, {
        title: 'T',
        questions: [],
      });
      expect(res.status).toBe(400);
    });

    it('accepts a short answer as a string or a list, and strips fields of other types', async () => {
      const { token, topic } = await setup();
      const res = await api('post', `/topics/${topic.id}/quizzes`, token, {
        title: 'T',
        questions: [
          question({ type: 'short_answer', correctAnswer: 'Paris', options: ['x', 'y'] }),
          question({ type: 'true_false', correctAnswer: 'FALSE', options: ['x', 'y'] }),
        ],
      });
      expect(res.status).toBe(201);
      const [short, tf] = res.body.data.quiz.questions;
      expect(short.correctAnswer).toBe('Paris');
      expect(short.options).toBeUndefined();
      expect(tf.correctAnswer).toBe('false');
      expect(tf.options).toBeUndefined();
    });
  });
});

describe('GET /topics/:topicId/quizzes', () => {
  it('lists summaries without questions, paginated and scoped to the topic and user', async () => {
    const { token, subject, topic } = await setup();
    await createQuiz(token, topic.id, { ...sampleQuiz, title: 'Second' });
    const otherTopic = await createTopic(token, subject.id, 'Integrals');
    await createQuiz(token, otherTopic.id);

    const res = await api('get', `/topics/${topic.id}/quizzes?limit=1`, token);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ page: 1, limit: 1, total: 2 });
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0]).toMatchObject({ title: 'Second', questionCount: 3 });
    expect(res.body.data.items[0].questions).toBeUndefined();

    const other = await registerUser('grace@example.com');
    expect((await api('get', `/topics/${topic.id}/quizzes`, other.token)).status).toBe(404);
  });
});

describe('answers are hidden while taking a quiz', () => {
  it('GET /quizzes/:id has no correctAnswer or explanation anywhere', async () => {
    const { token, quiz } = await setup();
    const res = await api('get', `/quizzes/${quiz.id}`, token);

    expect(res.status).toBe(200);
    const taken = res.body.data.quiz;
    expect(taken.questions).toHaveLength(3);
    for (const q of taken.questions) {
      expect(q).not.toHaveProperty('correctAnswer');
      expect(q).not.toHaveProperty('explanation');
    }
    expect(taken.questions[0]).toMatchObject({
      type: 'mcq',
      prompt: 'What is d/dx of x^2?',
      options: ['x', '2x', 'x^2'],
      points: 1,
    });

    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('correctAnswer');
    for (const q of sampleQuiz.questions) expect(raw).not.toContain(q.explanation);
    expect(raw).not.toContain('product rule');
  });

  it('GET /quizzes/:id/edit includes the answers for the owner only', async () => {
    const { token, quiz } = await setup();
    const res = await api('get', `/quizzes/${quiz.id}/edit`, token);
    expect(res.status).toBe(200);
    expect(res.body.data.quiz.questions[0]).toMatchObject({
      correctAnswer: '2x',
      explanation: 'Power rule: bring the exponent down.',
    });
    expect(res.body.data.quiz.questions[2].correctAnswer).toEqual(['product rule', 'leibniz rule']);

    const other = await registerUser('grace@example.com');
    expect((await api('get', `/quizzes/${quiz.id}/edit`, other.token)).status).toBe(404);
    expect((await api('get', `/quizzes/${quiz.id}`, other.token)).status).toBe(404);
  });
});

describe('PATCH /quizzes/:id', () => {
  it('updates fields and clears the time limit with null', async () => {
    const { token, quiz } = await setup();
    const res = await api('patch', `/quizzes/${quiz.id}`, token, {
      title: 'Renamed',
      timeLimitMinutes: 20,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.quiz).toMatchObject({ title: 'Renamed', timeLimitMinutes: 20 });
    expect(res.body.data.quiz.questions).toHaveLength(3);

    const cleared = await api('patch', `/quizzes/${quiz.id}`, token, { timeLimitMinutes: null });
    expect(cleared.body.data.quiz.timeLimitMinutes).toBeNull();

    expect((await api('patch', `/quizzes/${quiz.id}`, token, {})).status).toBe(400);
  });

  it('keeps ids of questions sent with their id, and drops the mistakes of removed ones', async () => {
    const { token, id, quiz } = await setup();
    await submit(token, quiz.id, answerAll(quiz, [false, false, false]));
    expect(await Mistake.countDocuments({ user: id })).toBe(3);

    const [first, , third] = quiz.questions;
    const res = await api('patch', `/quizzes/${quiz.id}`, token, {
      questions: [
        { ...first, prompt: 'Edited prompt' },
        { type: 'true_false', prompt: 'Brand new', correctAnswer: false, explanation: 'New.' },
        { ...third },
      ],
    });
    expect(res.status).toBe(200);
    const questions = res.body.data.quiz.questions;
    expect(questions).toHaveLength(3);
    expect(questions[0]).toMatchObject({ id: first.id, prompt: 'Edited prompt' });
    expect(questions[2].id).toBe(third.id);
    expect([first.id, third.id]).not.toContain(questions[1].id);

    // The removed (second) question's mistake is gone, the kept ones stay.
    const remaining = (await Mistake.find({ user: id })).map((m) => String(m.questionId)).sort();
    expect(remaining).toEqual([first.id, third.id].sort());
  });

  it('rejects question ids that are not in the quiz, or repeated', async () => {
    const { token, quiz } = await setup();
    const q = quiz.questions[0];

    const unknown = await api('patch', `/quizzes/${quiz.id}`, token, {
      questions: [{ ...q, id: fakeId }],
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe('INVALID_QUESTION_ID');

    const repeated = await api('patch', `/quizzes/${quiz.id}`, token, { questions: [q, q] });
    expect(repeated.status).toBe(400);
  });

  it('validates question rules on update and returns 404 for another user', async () => {
    const { token, quiz } = await setup();
    const bad = await api('patch', `/quizzes/${quiz.id}`, token, {
      questions: [{ ...quiz.questions[0], correctAnswer: 'nope' }],
    });
    expect(bad.status).toBe(400);

    const other = await registerUser('grace@example.com');
    const res = await api('patch', `/quizzes/${quiz.id}`, other.token, { title: 'Hacked' });
    expect(res.status).toBe(404);
    expect((await Quiz.findById(quiz.id)).title).toBe('Derivatives quiz');
  });
});

describe('DELETE /quizzes/:id', () => {
  it('deletes the quiz with its attempts and mistakes, and unlinks it from lessons', async () => {
    const { token, id, topic, quiz } = await setup();
    await createLesson(token, topic.id);
    await api('patch', `/topics/${topic.id}/lesson`, token, { exercises: [quiz.id] });
    await submit(token, quiz.id, answerAll(quiz, [false, true, true]));

    const res = await api('delete', `/quizzes/${quiz.id}`, token);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: quiz.id, deleted: { attempts: 1, mistakes: 1 } });

    expect(await Quiz.findById(quiz.id)).toBeNull();
    expect(await Attempt.countDocuments({ user: id })).toBe(0);
    expect(await Mistake.countDocuments({ user: id })).toBe(0);
    expect((await Lesson.findOne({ topic: topic.id })).exercises).toHaveLength(0);
    expect((await api('get', `/quizzes/${quiz.id}`, token)).status).toBe(404);
  });

  it('returns 404 and deletes nothing for another user', async () => {
    const { quiz } = await setup();
    const other = await registerUser('grace@example.com');
    expect((await api('delete', `/quizzes/${quiz.id}`, other.token)).status).toBe(404);
    expect(await Quiz.findById(quiz.id)).not.toBeNull();
  });

  it('is removed with its topic, together with attempts, mistakes and unlinks from other lessons', async () => {
    const { token, id, subject, topic, quiz } = await setup();
    await submit(token, quiz.id, answerAll(quiz, [false, true, true]));

    const lessonTopic = await createTopic(token, subject.id, 'Other topic');
    await createLesson(token, lessonTopic.id);
    await api('patch', `/topics/${lessonTopic.id}/lesson`, token, { exercises: [quiz.id] });

    const res = await api('delete', `/topics/${topic.id}`, token);
    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toMatchObject({ quizzes: 1, attempts: 1, mistakes: 1 });
    expect(await Quiz.countDocuments({ user: id })).toBe(0);
    expect((await Lesson.findOne({ topic: lessonTopic.id })).exercises).toHaveLength(0);
  });
});

describe('grading (isAnswerCorrect)', () => {
  const mcq = { type: 'mcq', correctAnswer: '2x' };
  const tf = { type: 'true_false', correctAnswer: 'true' };
  const short = { type: 'short_answer', correctAnswer: ['Product Rule', 'leibniz rule'] };
  const shortString = { type: 'short_answer', correctAnswer: 'Paris' };

  it.each([
    ['mcq exact', mcq, '2x', true],
    ['mcq wrong option', mcq, 'x', false],
    ['mcq is exact, not case-insensitive', { ...mcq, correctAnswer: 'B' }, 'b', false],
    ['mcq is exact, not trimmed', mcq, ' 2x', false],
    ['true_false true', tf, 'true', true],
    ['true_false wrong', tf, 'false', false],
    ['true_false ignores case', tf, 'TRUE', true],
    ['short exact', short, 'Product Rule', true],
    ['short is case-insensitive', short, 'pRoDuCt rUlE', true],
    ['short is trimmed', short, '   product rule  ', true],
    ['short matches any accepted answer', short, 'LEIBNIZ RULE', true],
    ['short wrong', short, 'chain rule', false],
    ['short does not match partially', short, 'product', false],
    ['short with a single string answer', shortString, ' paris ', true],
    ['short empty answer', shortString, '', false],
    ['unanswered is never correct', mcq, null, false],
  ])('%s', (_name, question, answer, expected) => {
    expect(isAnswerCorrect(question, answer)).toBe(expected);
  });
});

describe('POST /quizzes/:id/submit', () => {
  it('grades all three question types and returns score and per-question feedback', async () => {
    const { token, id, topic, quiz } = await setup();
    const res = await submit(token, quiz.id, answerAll(quiz, [true, true, true]), {
      durationSeconds: 95,
    });

    expect(res.status).toBe(201);
    const { attempt, feedback } = res.body.data;
    expect(attempt).toMatchObject({
      user: id,
      quiz: quiz.id,
      topic: topic.id,
      score: 4,
      maxScore: 4,
      percentage: 100,
      durationSeconds: 95,
    });
    expect(attempt.answers).toHaveLength(3);
    expect(attempt.answers.every((a) => a.isCorrect)).toBe(true);

    expect(feedback).toHaveLength(3);
    expect(feedback[0]).toMatchObject({
      questionId: quiz.questions[0].id,
      type: 'mcq',
      userAnswer: '2x',
      isCorrect: true,
      pointsEarned: 1,
      points: 1,
      correctAnswer: '2x',
      explanation: 'Power rule: bring the exponent down.',
    });
    // Short answer: graded case-insensitively and trimmed, feedback shows the accepted answers.
    expect(feedback[2]).toMatchObject({
      isCorrect: true,
      pointsEarned: 2,
      correctAnswer: ['product rule', 'leibniz rule'],
    });
  });

  it('scores each wrong answer as 0 and computes the percentage over the points', async () => {
    const { token, quiz } = await setup();

    // mcq right (1), true/false wrong, short wrong (2 points) -> 1 / 4.
    const res = await submit(token, quiz.id, answerAll(quiz, [true, false, false]));
    const { attempt, feedback } = res.body.data;
    expect(attempt).toMatchObject({ score: 1, maxScore: 4, percentage: 25 });
    expect(feedback.map((f) => f.isCorrect)).toEqual([true, false, false]);
    expect(feedback.map((f) => f.pointsEarned)).toEqual([1, 0, 0]);
    // The correct answer and the explanation are revealed for wrong answers.
    expect(feedback[1]).toMatchObject({
      userAnswer: 'false',
      correctAnswer: 'true',
      explanation: 'Constants do not change.',
    });
  });

  it('accepts true/false as a boolean or a string, and short answers with odd spacing', async () => {
    const { token, quiz } = await setup();
    const res = await submit(
      token,
      quiz.id,
      answerSet(quiz, [
        [0, '2x'],
        [1, 'True'],
        [2, '  LEIBNIZ rule '],
      ]),
    );
    expect(res.body.data.attempt.percentage).toBe(100);

    const bool = await submit(token, quiz.id, answerSet(quiz, [[1, true]]));
    expect(bool.body.data.feedback[1]).toMatchObject({ isCorrect: true, userAnswer: 'true' });
  });

  it('treats questions left out as unanswered: 0 points, not graded as wrong answers', async () => {
    const { token, id, quiz } = await setup();
    const res = await submit(token, quiz.id, answerSet(quiz, [[0, '2x']]));

    expect(res.status).toBe(201);
    const { attempt, feedback } = res.body.data;
    expect(attempt).toMatchObject({ score: 1, maxScore: 4, percentage: 25 });
    expect(feedback[1]).toMatchObject({ answered: false, userAnswer: null, isCorrect: false });
    expect(await Mistake.countDocuments({ user: id })).toBe(0);
  });

  it('stores the attempt', async () => {
    const { token, id, quiz } = await setup();
    await submit(
      token,
      quiz.id,
      answerAll(
        quiz,
        RIGHT.map(() => true),
      ),
    );
    const stored = await Attempt.find({ user: id });
    expect(stored).toHaveLength(1);
    expect(stored[0].answers.map((a) => a.answer)).toEqual(['2x', 'true', 'Product Rule']);
  });

  it('logs quiz_submitted with the score and the topic', async () => {
    const { token, id, topic, quiz } = await setup();
    const res = await submit(token, quiz.id, answerAll(quiz, [true, false, true]));

    const events = await ActivityLog.find({ user: id, type: 'quiz_submitted' });
    expect(events).toHaveLength(1);
    expect(String(events[0].refId)).toBe(res.body.data.attempt.id);
    expect(events[0].metadata).toMatchObject({
      quizId: quiz.id,
      topicId: topic.id,
      score: 3,
      maxScore: 4,
      percentage: 75,
    });
  });

  it.each([
    ['unknown question id', () => [{ questionId: fakeId, answer: 'x' }], 400],
    [
      'the same question twice',
      (quiz) => [
        { questionId: quiz.questions[0].id, answer: 'x' },
        { questionId: quiz.questions[0].id, answer: '2x' },
      ],
      400,
    ],
    ['malformed question id', () => [{ questionId: 'nope', answer: 'x' }], 400],
    ['no answers', () => [], 400],
    ['an object as the answer', (quiz) => [{ questionId: quiz.questions[0].id, answer: {} }], 400],
  ])('rejects %s', async (_name, build, status) => {
    const { token, id, quiz } = await setup();
    const res = await submit(token, quiz.id, build(quiz));
    expect(res.status).toBe(status);
    expect(await Attempt.countDocuments({ user: id })).toBe(0);
  });

  it('rejects an invalid duration', async () => {
    const { token, quiz } = await setup();
    const res = await submit(token, quiz.id, answerAll(quiz, [true, true, true]), {
      durationSeconds: -5,
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 when submitting to another user's quiz", async () => {
    const { quiz } = await setup();
    const other = await registerUser('grace@example.com');
    const res = await submit(other.token, quiz.id, answerAll(quiz, [true, true, true]));
    expect(res.status).toBe(404);
    expect(await Attempt.countDocuments()).toBe(0);
  });
});

describe('attempt history', () => {
  it('lists attempts newest first and returns one attempt with its feedback', async () => {
    const { token, quiz } = await setup();
    const first = await submit(token, quiz.id, answerAll(quiz, [false, false, false]));
    const second = await submit(token, quiz.id, answerAll(quiz, [true, true, true]));

    const list = await api('get', `/quizzes/${quiz.id}/attempts?limit=1`, token);
    expect(list.status).toBe(200);
    expect(list.body.data).toMatchObject({ page: 1, limit: 1, total: 2 });
    expect(list.body.data.items[0]).toMatchObject({
      id: second.body.data.attempt.id,
      percentage: 100,
    });
    expect(list.body.data.items[0].answers).toBeUndefined();

    const page2 = await api('get', `/quizzes/${quiz.id}/attempts?limit=1&page=2`, token);
    expect(page2.body.data.items[0].id).toBe(first.body.data.attempt.id);

    const one = await api('get', `/attempts/${first.body.data.attempt.id}`, token);
    expect(one.status).toBe(200);
    expect(one.body.data.attempt).toMatchObject({ percentage: 0, score: 0 });
    expect(one.body.data.attempt.answers).toHaveLength(3);
    expect(one.body.data.feedback).toHaveLength(3);
    expect(one.body.data.feedback[0]).toMatchObject({
      isCorrect: false,
      userAnswer: 'x',
      correctAnswer: '2x',
      explanation: 'Power rule: bring the exponent down.',
    });
  });

  it("does not expose another user's attempts", async () => {
    const { token, quiz } = await setup();
    const res = await submit(token, quiz.id, answerAll(quiz, [true, true, true]));
    const other = await registerUser('grace@example.com');

    expect((await api('get', `/attempts/${res.body.data.attempt.id}`, other.token)).status).toBe(
      404,
    );
    expect((await api('get', `/quizzes/${quiz.id}/attempts`, other.token)).status).toBe(404);
  });
});

describe('PATCH /topics/:topicId/lesson exercises', () => {
  it('links quizzes owned by the user, replaces the list and can clear it', async () => {
    const { token, topic, quiz } = await setup();
    const second = await createQuiz(token, topic.id, { ...sampleQuiz, title: 'Two' });
    await createLesson(token, topic.id);

    const res = await api('patch', `/topics/${topic.id}/lesson`, token, {
      exercises: [quiz.id, second.id],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.lesson.exercises).toEqual([quiz.id, second.id]);

    const read = await api('get', `/topics/${topic.id}/lesson`, token);
    expect(read.body.data.lesson.exercises).toEqual([quiz.id, second.id]);

    const replaced = await api('patch', `/topics/${topic.id}/lesson`, token, {
      exercises: [second.id],
    });
    expect(replaced.body.data.lesson.exercises).toEqual([second.id]);

    const cleared = await api('patch', `/topics/${topic.id}/lesson`, token, { exercises: [] });
    expect(cleared.body.data.lesson.exercises).toEqual([]);
  });

  it('can be combined with other fields, and does not change when omitted', async () => {
    const { token, topic, quiz } = await setup();
    await createLesson(token, topic.id);
    await api('patch', `/topics/${topic.id}/lesson`, token, { exercises: [quiz.id] });

    const res = await api('patch', `/topics/${topic.id}/lesson`, token, { title: 'New title' });
    expect(res.body.data.lesson).toMatchObject({ title: 'New title', exercises: [quiz.id] });
  });

  it('rejects quizzes of another user or that do not exist, without changing the lesson', async () => {
    const { token, topic, quiz } = await setup();
    const other = await registerUser('grace@example.com');
    const otherSubject = await createSubject(other.token);
    const otherTopic = await createTopic(other.token, otherSubject.id);
    const foreign = await createQuiz(other.token, otherTopic.id);
    await createLesson(token, topic.id);
    await api('patch', `/topics/${topic.id}/lesson`, token, { exercises: [quiz.id] });

    for (const bad of [foreign.id, fakeId]) {
      const res = await api('patch', `/topics/${topic.id}/lesson`, token, {
        exercises: [quiz.id, bad],
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_EXERCISES');
    }
    const read = await api('get', `/topics/${topic.id}/lesson`, token);
    expect(read.body.data.lesson.exercises).toEqual([quiz.id]);
  });

  it('rejects malformed and repeated ids', async () => {
    const { token, topic, quiz } = await setup();
    await createLesson(token, topic.id);
    for (const exercises of [['nope'], [quiz.id, quiz.id], 'x']) {
      const res = await api('patch', `/topics/${topic.id}/lesson`, token, { exercises });
      expect(res.status).toBe(400);
    }
  });
});
