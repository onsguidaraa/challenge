import request from 'supertest';
import app from '../src/app.js';
import { ActivityLog, ACTIVITY_TYPES } from '../src/modules/activity-log/activity-log.model.js';
import { startTestDb, clearTestDb, stopTestDb } from './helpers/db.js';
import { API, validOnboarding, registerUser, bearer } from './helpers/auth.js';
import { api, createSubject, createTopic, createLesson } from './helpers/space.js';
import { createCard, createQuiz, submit, answerAll } from './helpers/practice.js';
import { createTask, complete, startSession, stopSession } from './helpers/planner.js';

beforeAll(async () => {
  await startTestDb();
}, 120000);

afterEach(async () => {
  await clearTestDb();
});

afterAll(async () => {
  await stopTestDb();
});

/**
 * Audit of the Phase 1-5 wiring: every real user action that should leave a trace in the
 * ActivityLog does, exactly once, with the metadata the progress reports rely on.
 */
describe('ActivityLog wiring', () => {
  it('logs each of the 8 event types from the real endpoints', async () => {
    const { id, token } = await registerUser();

    await request(app).post(`${API}/onboarding`).set(bearer(token)).send(validOnboarding);

    const subject = await createSubject(token);
    const topic = await createTopic(token, subject.id);
    await createLesson(token, topic.id);
    const card = (await createCard(token, topic.id)).body.data.flashcard;
    const quiz = await createQuiz(token, topic.id);
    const task = await createTask(token, { topic: topic.id });

    await api('get', `/topics/${topic.id}/lesson?format=diagram`, token);
    await api('post', `/topics/${topic.id}/lesson/complete`, token);
    await submit(token, quiz.id, answerAll(quiz, [true, false, true]));
    await api('post', `/flashcards/${card.id}/review`, token, { rating: 'good' });
    const session = (await startSession(token, { topic: topic.id })).body.data.session;
    await stopSession(token, session.id);
    await complete(token, task.id);

    const events = await ActivityLog.find({ user: id }).lean();
    const byType = {};
    for (const event of events) (byType[event.type] ??= []).push(event);

    for (const type of ACTIVITY_TYPES) {
      expect({ type, count: byType[type]?.length ?? 0 }).toEqual({ type, count: 1 });
    }

    expect(byType.lesson_opened[0].metadata).toMatchObject({
      format: 'diagram',
      topicId: topic.id,
    });
    expect(byType.quiz_submitted[0].metadata).toMatchObject({
      topicId: topic.id,
      quizId: quiz.id,
      percentage: expect.any(Number),
    });
    expect(byType.session_finished[0].metadata).toHaveProperty('durationMinutes');
    expect(byType.session_finished[0].refId.toString()).toBe(session.id);
    expect(byType.session_started[0].refId.toString()).toBe(session.id);
  });

  it('does not log twice for idempotent actions', async () => {
    const { id, token } = await registerUser();
    const subject = await createSubject(token);
    const topic = await createTopic(token, subject.id);
    await createLesson(token, topic.id);
    const task = await createTask(token);

    await api('post', `/topics/${topic.id}/lesson/complete`, token);
    await api('post', `/topics/${topic.id}/lesson/complete`, token);
    await complete(token, task.id);
    await complete(token, task.id);

    expect(await ActivityLog.countDocuments({ user: id, type: 'lesson_completed' })).toBe(1);
    expect(await ActivityLog.countDocuments({ user: id, type: 'task_completed' })).toBe(1);
  });
});
