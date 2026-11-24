import mongoose from 'mongoose';
import request from 'supertest';
import app from '../src/app.js';
import { StudyPlan, Task, StudySession } from '../src/modules/planner/planner.model.js';
import {
  startOfUtcDay,
  getRangeBounds,
  toDateKey,
} from '../src/modules/planner/planner.helpers.js';
import { ActivityLog } from '../src/modules/activity-log/activity-log.model.js';
import { Profile } from '../src/modules/profile/profile.model.js';
import { Topic } from '../src/modules/space/space.model.js';
import { startTestDb, clearTestDb, stopTestDb } from './helpers/db.js';
import { API, registerUser } from './helpers/auth.js';
import { api, createSubject, createTopic } from './helpers/space.js';
import { createQuiz, submit, answerAll, createCard } from './helpers/practice.js';
import {
  DAY,
  HOUR,
  fakeId,
  iso,
  createPlan,
  createPlanTask,
  createTask,
  complete,
  startSession,
  stopSession,
} from './helpers/planner.js';

beforeAll(async () => {
  await startTestDb();
}, 120000);

afterEach(async () => {
  await clearTestDb();
});

afterAll(async () => {
  await stopTestDb();
});

/** Midnight UTC today + `days` days + `hours` hours, as an ISO string. */
const at = (days, hours = 9) =>
  new Date(startOfUtcDay(new Date()).getTime() + days * DAY + hours * HOUR).toISOString();

/** Pretends a session started `ms` ago. */
const backdate = (sessionId, ms) =>
  StudySession.updateOne({ _id: sessionId }, { $set: { startedAt: new Date(Date.now() - ms) } });

describe('auth', () => {
  it.each([
    ['get', '/plans'],
    ['post', '/plans'],
    ['get', `/plans/${fakeId}`],
    ['get', '/tasks'],
    ['get', '/tasks/upcoming'],
    ['patch', `/tasks/${fakeId}/complete`],
    ['post', '/sessions/start'],
    ['get', '/sessions/active'],
    ['get', '/sessions/stats'],
    ['get', '/planner/suggestions'],
  ])('%s %s requires authentication', async (method, path) => {
    const res = await request(app)[method](`${API}${path}`);
    expect(res.status).toBe(401);
  });
});

describe('plans', () => {
  it('creates, lists (with status filter), gets, updates and deletes a plan', async () => {
    const { token } = await registerUser();
    const subject = await createSubject(token);

    const create = await api('post', '/plans', token, {
      title: 'Finals',
      description: 'Everything',
      goal: 'Score 90%',
      targetDate: '2026-12-20',
      startDate: '2026-12-01',
      subjects: [subject.id],
    });
    expect(create.status).toBe(201);
    expect(create.body.data.plan).toMatchObject({
      title: 'Finals',
      goal: 'Score 90%',
      status: 'active',
      progress: 0,
      subjects: [subject.id],
    });
    const { id } = create.body.data.plan;

    await createPlan(token, { title: 'Old', status: 'archived' });

    const all = await api('get', '/plans', token);
    expect(all.body.data).toMatchObject({ page: 1, limit: 20, total: 2 });
    const archived = await api('get', '/plans?status=archived', token);
    expect(archived.body.data.items.map((p) => p.title)).toEqual(['Old']);
    expect((await api('get', '/plans?status=bogus', token)).status).toBe(400);

    const patch = await api('patch', `/plans/${id}`, token, {
      status: 'paused',
      title: 'Finals 2',
    });
    expect(patch.status).toBe(200);
    expect(patch.body.data.plan).toMatchObject({ status: 'paused', title: 'Finals 2' });

    expect((await api('delete', `/plans/${id}`, token)).status).toBe(200);
    expect((await api('get', `/plans/${id}`, token)).status).toBe(404);
  });

  it('validates input', async () => {
    const { token } = await registerUser();
    expect((await api('post', '/plans', token, {})).status).toBe(400);
    expect((await api('post', '/plans', token, { title: 'x', status: 'nope' })).status).toBe(400);
    expect(
      (await api('post', '/plans', token, { title: 'x', targetDate: 'tomorrow' })).status,
    ).toBe(400);
    const dates = await api('post', '/plans', token, {
      title: 'x',
      startDate: '2026-12-10',
      targetDate: '2026-12-01',
    });
    expect(dates.status).toBe(400);
    const plan = await createPlan(token, { startDate: '2026-12-10' });
    expect((await api('patch', `/plans/${plan.id}`, token, {})).status).toBe(400);
    expect(
      (await api('patch', `/plans/${plan.id}`, token, { targetDate: '2026-12-01' })).status,
    ).toBe(400);
    expect((await api('get', '/plans/not-an-id', token)).status).toBe(400);
  });

  it('ignores a client-supplied progress', async () => {
    const { token } = await registerUser();
    const plan = await createPlan(token, { progress: 100 });
    expect(plan.progress).toBe(0);
    const patch = await api('patch', `/plans/${plan.id}`, token, { progress: 100, goal: 'g' });
    expect(patch.body.data.plan.progress).toBe(0);
  });

  it('deletes the tasks of a deleted plan but keeps standalone tasks and sessions', async () => {
    const { id: userId, token } = await registerUser();
    const plan = await createPlan(token);
    const planTask = await createPlanTask(token, plan.id);
    const standalone = await createTask(token);
    const session = (await startSession(token, { task: planTask.id })).body.data.session;

    const res = await api('delete', `/plans/${plan.id}`, token);
    expect(res.body.data).toMatchObject({ id: plan.id, deletedTasks: 1 });
    expect(await Task.countDocuments({ user: userId })).toBe(1);
    expect(await Task.exists({ _id: standalone.id })).toBeTruthy();
    expect((await StudySession.findById(session.id)).task).toBeNull();
  });
});

describe('plan progress', () => {
  it('is the percentage of completed tasks and appears in GET /plans/:id with counts', async () => {
    const { token } = await registerUser();
    const plan = await createPlan(token);

    const empty = await api('get', `/plans/${plan.id}`, token);
    expect(empty.body.data.plan).toMatchObject({
      progress: 0,
      taskCounts: { total: 0, todo: 0, in_progress: 0, done: 0, skipped: 0 },
    });

    const tasks = [];
    for (let i = 0; i < 4; i += 1)
      tasks.push(await createPlanTask(token, plan.id, { title: `T${i}` }));

    await complete(token, tasks[0].id);
    let res = await api('get', `/plans/${plan.id}`, token);
    expect(res.body.data.plan.progress).toBe(25);
    expect(res.body.data.plan.taskCounts).toMatchObject({ total: 4, todo: 3, done: 1 });

    await complete(token, tasks[1].id);
    await api('patch', `/tasks/${tasks[2].id}`, token, { status: 'in_progress' });
    res = await api('get', `/plans/${plan.id}`, token);
    expect(res.body.data.plan.progress).toBe(50);
    expect(res.body.data.plan.taskCounts).toMatchObject({ todo: 1, in_progress: 1, done: 2 });

    // Skipped tasks do not count: 2 done out of 3 remaining.
    await api('patch', `/tasks/${tasks[3].id}`, token, { status: 'skipped' });
    res = await api('get', `/plans/${plan.id}`, token);
    expect(res.body.data.plan.progress).toBe(67);

    // The stored value follows too (it is what GET /plans lists).
    const list = await api('get', '/plans', token);
    expect(list.body.data.items[0].progress).toBe(67);
  });

  it('is recomputed on complete, reopen, create, delete and when a task changes plan', async () => {
    const { token } = await registerUser();
    const plan = await createPlan(token);
    const other = await createPlan(token, { title: 'Other' });
    const a = await createPlanTask(token, plan.id);
    const b = await createPlanTask(token, plan.id);
    const stored = async (id) => (await StudyPlan.findById(id)).progress;

    const done = await complete(token, a.id);
    expect(done.body.data.planProgress).toBe(50);
    expect(await stored(plan.id)).toBe(50);

    const reopened = await api('patch', `/tasks/${a.id}/reopen`, token);
    expect(reopened.body.data.planProgress).toBe(0);

    await complete(token, a.id);
    await createPlanTask(token, plan.id);
    expect(await stored(plan.id)).toBe(33);

    await api('delete', `/tasks/${b.id}`, token);
    expect(await stored(plan.id)).toBe(50);

    await api('patch', `/tasks/${a.id}`, token, { plan: other.id });
    expect(await stored(plan.id)).toBe(0);
    expect(await stored(other.id)).toBe(100);
  });
});

describe('tasks', () => {
  it('creates tasks with defaults under a plan and standalone', async () => {
    const { token } = await registerUser();
    const plan = await createPlan(token);

    const planTask = await createPlanTask(token, plan.id);
    expect(planTask).toMatchObject({
      plan: plan.id,
      type: 'study',
      priority: 'medium',
      status: 'todo',
      completedAt: null,
      recurrence: { type: 'none', until: null },
    });

    const standalone = await createTask(token, {
      title: 'Quiz me',
      type: 'quiz',
      priority: 'high',
      dueDate: '2026-12-01',
      estimatedMinutes: 30,
      notes: 'ch 3',
      plan: plan.id, // ignored on /tasks
    });
    expect(standalone).toMatchObject({
      plan: null,
      type: 'quiz',
      priority: 'high',
      estimatedMinutes: 30,
      notes: 'ch 3',
    });
    expect(standalone.dueDate).toBe('2026-12-01T00:00:00.000Z');
  });

  it('GET /tasks lists standalone tasks only, with filters; plan tasks list under the plan', async () => {
    const { token } = await registerUser();
    const subject = await createSubject(token);
    const topic = await createTopic(token, subject.id);
    const plan = await createPlan(token);
    await createPlanTask(token, plan.id, { title: 'In plan' });

    await createTask(token, { title: 'A', priority: 'high', dueDate: '2026-12-01T10:00:00Z' });
    await createTask(token, {
      title: 'B',
      priority: 'low',
      dueDate: '2026-12-10',
      topic: topic.id,
    });
    const c = await createTask(token, { title: 'C', dueDate: '2026-12-20' });
    await api('patch', `/tasks/${c.id}`, token, { status: 'in_progress' });

    const titles = async (path) =>
      (await api('get', path, token)).body.data.items.map((t) => t.title).sort();

    expect(await titles('/tasks')).toEqual(['A', 'B', 'C']);
    expect(await titles('/tasks?status=in_progress')).toEqual(['C']);
    expect(await titles('/tasks?priority=high')).toEqual(['A']);
    expect(await titles(`/tasks?topic=${topic.id}`)).toEqual(['B']);
    expect(await titles('/tasks?dueFrom=2026-12-05')).toEqual(['B', 'C']);
    expect(await titles('/tasks?dueTo=2026-12-10')).toEqual(['A', 'B']); // date-only = end of day
    expect(await titles('/tasks?dueFrom=2026-12-05&dueTo=2026-12-15')).toEqual(['B']);
    expect(await titles(`/plans/${plan.id}/tasks`)).toEqual(['In plan']);
    expect(await titles(`/plans/${plan.id}/tasks?status=done`)).toEqual([]);

    const page = await api('get', '/tasks?limit=2&page=2', token);
    expect(page.body.data).toMatchObject({ page: 2, limit: 2, total: 3 });
    expect(page.body.data.items).toHaveLength(1);

    expect((await api('get', '/tasks?status=nope', token)).status).toBe(400);
    expect((await api('get', '/tasks?priority=urgent', token)).status).toBe(400);
    expect((await api('get', '/tasks?topic=nope', token)).status).toBe(400);
    expect((await api('get', '/tasks?dueFrom=yesterday', token)).status).toBe(400);
    expect((await api('get', '/tasks?dueFrom=2026-12-10&dueTo=2026-12-01', token)).status).toBe(
      400,
    );
  });

  it('gets, updates and deletes a task', async () => {
    const { token } = await registerUser();
    const task = await createTask(token);

    expect((await api('get', `/tasks/${task.id}`, token)).body.data.task.title).toBe('Standalone');

    const patch = await api('patch', `/tasks/${task.id}`, token, {
      title: 'Renamed',
      priority: 'low',
      dueDate: null,
      status: 'skipped',
    });
    expect(patch.body.data.task).toMatchObject({
      title: 'Renamed',
      priority: 'low',
      dueDate: null,
      status: 'skipped',
    });

    expect((await api('patch', `/tasks/${task.id}`, token, {})).status).toBe(400);
    expect((await api('patch', `/tasks/${task.id}`, token, { status: 'done' })).status).toBe(400);
    expect((await api('patch', `/tasks/${task.id}`, token, { priority: 'x' })).status).toBe(400);

    expect((await api('delete', `/tasks/${task.id}`, token)).status).toBe(200);
    expect((await api('get', `/tasks/${task.id}`, token)).status).toBe(404);
    expect((await api('delete', `/tasks/${task.id}`, token)).status).toBe(404);
  });

  it('validates recurrence', async () => {
    const { token } = await registerUser();
    const noDue = await api('post', '/tasks', token, { title: 'x', recurrence: { type: 'daily' } });
    expect(noDue.status).toBe(400);
    expect(noDue.body.error.code).toBe('RECURRENCE_NEEDS_DUE_DATE');

    const badUntil = await api('post', '/tasks', token, {
      title: 'x',
      dueDate: at(3),
      recurrence: { type: 'daily', until: at(1) },
    });
    expect(badUntil.status).toBe(400);

    const untilNoType = await api('post', '/tasks', token, {
      title: 'x',
      dueDate: at(3),
      recurrence: { type: 'none', until: at(5) },
    });
    expect(untilNoType.status).toBe(400);
    expect(
      (
        await api('post', '/tasks', token, {
          title: 'x',
          dueDate: at(1),
          recurrence: { type: 'monthly' },
        })
      ).status,
    ).toBe(400);

    const task = await createTask(token, { dueDate: at(1), recurrence: { type: 'weekly' } });
    expect((await api('patch', `/tasks/${task.id}`, token, { dueDate: null })).status).toBe(400);
    expect(
      (await api('patch', `/tasks/${task.id}`, token, { recurrence: { type: 'none' } })).status,
    ).toBe(200);
  });
});

describe('completing and reopening tasks', () => {
  it('sets status and completedAt, logs task_completed and is idempotent', async () => {
    const { id: userId, token } = await registerUser();
    const subject = await createSubject(token);
    const topic = await createTopic(token, subject.id);
    const plan = await createPlan(token);
    const task = await createPlanTask(token, plan.id, { topic: topic.id, type: 'revise' });

    const res = await complete(token, task.id);
    expect(res.status).toBe(200);
    expect(res.body.data.task).toMatchObject({ status: 'done', subject: subject.id });
    expect(new Date(res.body.data.task.completedAt).getTime()).toBeGreaterThan(Date.now() - 5000);
    expect(res.body.data.nextTask).toBeNull();
    expect(res.body.data.planProgress).toBe(100);

    const events = await ActivityLog.find({ user: userId, type: 'task_completed' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ refModel: 'Task' });
    expect(String(events[0].refId)).toBe(task.id);
    expect(events[0].metadata).toMatchObject({
      taskId: task.id,
      planId: plan.id,
      topicId: topic.id,
      taskType: 'revise',
    });

    const again = await complete(token, task.id);
    expect(again.status).toBe(200);
    expect(again.body.data.task.completedAt).toBe(res.body.data.task.completedAt);
    expect(await ActivityLog.countDocuments({ user: userId, type: 'task_completed' })).toBe(1);
  });

  it('does not let a double concurrent complete log or spawn twice', async () => {
    const { id: userId, token } = await registerUser();
    const task = await createTask(token, { dueDate: at(1), recurrence: { type: 'daily' } });

    await Promise.all([complete(token, task.id), complete(token, task.id)]);

    expect(await ActivityLog.countDocuments({ user: userId, type: 'task_completed' })).toBe(1);
    expect(await Task.countDocuments({ user: userId })).toBe(2);
  });

  it('creates the next occurrence of a daily task', async () => {
    const { token } = await registerUser();
    const plan = await createPlan(token);
    const task = await createPlanTask(token, plan.id, {
      title: 'Flashcards',
      type: 'revise',
      priority: 'high',
      estimatedMinutes: 15,
      notes: 'daily habit',
      dueDate: at(1, 8),
      recurrence: { type: 'daily' },
    });

    const res = await complete(token, task.id);
    const { nextTask } = res.body.data;
    expect(nextTask).toMatchObject({
      plan: plan.id,
      title: 'Flashcards',
      type: 'revise',
      priority: 'high',
      estimatedMinutes: 15,
      notes: 'daily habit',
      status: 'todo',
      completedAt: null,
      recurrence: { type: 'daily', until: null },
      dueDate: at(2, 8),
    });
    expect(nextTask.id).not.toBe(task.id);
    // Plan progress includes the new occurrence: 1 done of 2.
    expect(res.body.data.planProgress).toBe(50);
    expect((await api('get', `/tasks/${task.id}`, token)).body.data.task.nextOccurrence).toBe(
      nextTask.id,
    );
  });

  it('creates the next occurrence of a weekly task, until the until date', async () => {
    const { token } = await registerUser();
    const first = await createTask(token, {
      dueDate: at(1),
      recurrence: { type: 'weekly', until: at(8) },
    });

    const second = (await complete(token, first.id)).body.data.nextTask;
    expect(second.dueDate).toBe(at(8));
    expect(second.recurrence.until).toBe(at(8));

    // The following occurrence would be after `until`: the series ends.
    const last = await complete(token, second.id);
    expect(last.body.data.nextTask).toBeNull();
    expect(await Task.countDocuments({})).toBe(2);
  });

  it('does not create an occurrence for non-recurring tasks', async () => {
    const { token } = await registerUser();
    const task = await createTask(token, { dueDate: at(1) });
    expect((await complete(token, task.id)).body.data.nextTask).toBeNull();
    expect(await Task.countDocuments({})).toBe(1);
  });

  it('reopens a completed task and removes its untouched next occurrence', async () => {
    const { token } = await registerUser();
    const task = await createTask(token, { dueDate: at(1), recurrence: { type: 'daily' } });
    const { nextTask } = (await complete(token, task.id)).body.data;

    const res = await api('patch', `/tasks/${task.id}/reopen`, token);
    expect(res.status).toBe(200);
    expect(res.body.data.task).toMatchObject({ status: 'todo', completedAt: null });
    expect((await api('get', `/tasks/${nextTask.id}`, token)).status).toBe(404);

    // Completing it again spawns the occurrence again, once.
    const again = await complete(token, task.id);
    expect(again.body.data.nextTask.dueDate).toBe(at(2));
    expect(await Task.countDocuments({})).toBe(2);
  });

  it('keeps a next occurrence that was already worked on and never duplicates it', async () => {
    const { token } = await registerUser();
    const task = await createTask(token, { dueDate: at(1), recurrence: { type: 'daily' } });
    const { nextTask } = (await complete(token, task.id)).body.data;
    await api('patch', `/tasks/${nextTask.id}`, token, { status: 'in_progress' });

    await api('patch', `/tasks/${task.id}/reopen`, token);
    expect((await api('get', `/tasks/${nextTask.id}`, token)).status).toBe(200);

    const again = await complete(token, task.id);
    expect(again.body.data.nextTask).toBeNull();
    expect(await Task.countDocuments({})).toBe(2);
  });

  it('refuses to reopen a task that is not done and to change the status of a done one', async () => {
    const { token } = await registerUser();
    const task = await createTask(token);

    const notDone = await api('patch', `/tasks/${task.id}/reopen`, token);
    expect(notDone.status).toBe(409);
    expect(notDone.body.error.code).toBe('TASK_NOT_DONE');

    await complete(token, task.id);
    const patch = await api('patch', `/tasks/${task.id}`, token, { status: 'todo' });
    expect(patch.status).toBe(409);
    expect(patch.body.error.code).toBe('TASK_ALREADY_DONE');
    // Other fields can still be edited.
    expect((await api('patch', `/tasks/${task.id}`, token, { title: 'New' })).status).toBe(200);
  });

  it('returns 404 / 400 for unknown or malformed ids', async () => {
    const { token } = await registerUser();
    expect((await complete(token, fakeId)).status).toBe(404);
    expect((await api('patch', `/tasks/${fakeId}/reopen`, token)).status).toBe(404);
    expect((await complete(token, 'nope')).status).toBe(400);
  });
});

describe('upcoming tasks', () => {
  const upcoming = (token, query = '') => api('get', `/tasks/upcoming${query}`, token);

  it('groups tasks by date within the day range and lists overdue tasks apart', async () => {
    const { token } = await registerUser();
    const plan = await createPlan(token);
    const t1 = await createTask(token, { title: 'Tomorrow late', dueDate: at(1, 17) });
    const t2 = await createPlanTask(token, plan.id, { title: 'Tomorrow early', dueDate: at(1, 8) });
    await createTask(token, { title: 'Day after', dueDate: at(2) });
    await createTask(token, { title: 'No date' });
    await createTask(token, { title: 'Overdue open', dueDate: at(-2) });
    const overdueDone = await createTask(token, { title: 'Overdue done', dueDate: at(-3) });
    await complete(token, overdueDone.id);
    const skipped = await createTask(token, { title: 'Skipped', dueDate: at(1, 12) });
    await api('patch', `/tasks/${skipped.id}`, token, { status: 'skipped' });

    const res = await upcoming(token, `?range=day&date=${at(1)}`);
    expect(res.status).toBe(200);
    expect(res.body.data.range).toBe('day');
    expect(res.body.data.groups).toHaveLength(1);
    expect(res.body.data.groups[0].date).toBe(toDateKey(new Date(at(1))));
    expect(res.body.data.groups[0].tasks.map((t) => t.id)).toEqual([t2.id, t1.id]);
    expect(res.body.data.overdue.map((t) => t.title)).toEqual(['Overdue open']);
  });

  it('week and month ranges group by date, ascending, over the whole window', async () => {
    const { token } = await registerUser();
    const anchor = at(1, 12);
    const week = getRangeBounds('week', new Date(anchor));
    const month = getRangeBounds('month', new Date(anchor));

    const offsets = [1, 2, 3, 9, 20, 40];
    for (const days of offsets) await createTask(token, { title: `d${days}`, dueDate: at(days) });

    const inside = (bounds) =>
      offsets.filter((d) => {
        const t = new Date(at(d));
        return t >= bounds.from && t < bounds.to;
      });

    const weekRes = await upcoming(token, `?range=week&date=${anchor}`);
    const weekDates = weekRes.body.data.groups.map((g) => g.date);
    expect(weekDates).toEqual(inside(week).map((d) => toDateKey(new Date(at(d)))));
    expect(weekDates).toEqual([...weekDates].sort());
    expect(weekRes.body.data.from).toBe(week.from.toISOString());
    expect(weekRes.body.data.to).toBe(week.to.toISOString());

    const monthRes = await upcoming(token, `?range=month&date=${anchor}`);
    expect(
      monthRes.body.data.groups
        .flatMap((g) => g.tasks)
        .map((t) => t.title)
        .sort(),
    ).toEqual(
      inside(month)
        .map((d) => `d${d}`)
        .sort(),
    );
  });

  it('puts several tasks of the same date in one group and defaults to the current week', async () => {
    const { token } = await registerUser();
    await createTask(token, { title: 'a', dueDate: at(0, 23) });
    await createTask(token, { title: 'b', dueDate: at(0, 23) });

    const res = await upcoming(token);
    expect(res.body.data.range).toBe('week');
    const today = res.body.data.groups.find((g) => g.date === toDateKey(new Date(at(0))));
    expect(today.tasks.map((t) => t.title).sort()).toEqual(['a', 'b']);
  });

  it('moves a task out of overdue once it is completed', async () => {
    const { token } = await registerUser();
    const task = await createTask(token, { dueDate: at(-1) });
    expect((await upcoming(token, '?range=day')).body.data.overdue).toHaveLength(1);
    await complete(token, task.id);
    expect((await upcoming(token, '?range=day')).body.data.overdue).toHaveLength(0);
  });

  it('validates the query', async () => {
    const { token } = await registerUser();
    expect((await upcoming(token, '?range=year')).status).toBe(400);
    expect((await upcoming(token, '?date=soon')).status).toBe(400);
  });
});

describe('study sessions', () => {
  it('starts a session, exposes it as active, and logs session_started', async () => {
    const { id: userId, token } = await registerUser();
    const subject = await createSubject(token);
    const topic = await createTopic(token, subject.id);
    const task = await createTask(token, { topic: topic.id });

    expect((await api('get', '/sessions/active', token)).body.data.session).toBeNull();

    const res = await startSession(token, { task: task.id, plannedMinutes: 45, notes: 'focus' });
    expect(res.status).toBe(201);
    expect(res.body.data.session).toMatchObject({
      task: task.id,
      topic: topic.id, // taken from the task
      plannedMinutes: 45,
      status: 'active',
      endedAt: null,
      durationMinutes: null,
      notes: 'focus',
    });
    expect(res.body.data.abandonedSessions).toBe(0);

    const active = await api('get', '/sessions/active', token);
    expect(active.body.data.session.id).toBe(res.body.data.session.id);

    const events = await ActivityLog.find({ user: userId, type: 'session_started' });
    expect(events).toHaveLength(1);
    expect(String(events[0].refId)).toBe(res.body.data.session.id);
    expect(events[0].metadata).toMatchObject({ taskId: task.id, topicId: topic.id });
  });

  it('starts a session with no body', async () => {
    const { token } = await registerUser();
    const res = await request(app)
      .post(`${API}/sessions/start`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(201);
  });

  it('allows only one active session per user (409), but a new one after stopping', async () => {
    const { token } = await registerUser();
    const other = await registerUser('grace@example.com');

    const first = await startSession(token);
    expect(first.status).toBe(201);

    const second = await startSession(token);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('SESSION_ALREADY_ACTIVE');
    expect(second.body.error.details.sessionId).toBe(first.body.data.session.id);

    // Another user is not affected.
    expect((await startSession(other.token)).status).toBe(201);

    await stopSession(token, first.body.data.session.id);
    expect((await startSession(token)).status).toBe(201);
  });

  it('allows only one active session when two starts race', async () => {
    const { id: userId, token } = await registerUser();
    const results = await Promise.all([
      startSession(token),
      startSession(token),
      startSession(token),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(await StudySession.countDocuments({ user: userId, status: 'active' })).toBe(1);
  });

  it('computes the duration on stop and stores notes and focusRating', async () => {
    const { id: userId, token } = await registerUser();
    const { session } = (await startSession(token, { plannedMinutes: 30 })).body.data;
    await backdate(session.id, 25 * 60 * 1000);

    const res = await stopSession(token, session.id, { notes: 'Good one', focusRating: 4 });
    expect(res.status).toBe(200);
    expect(res.body.data.session).toMatchObject({
      status: 'completed',
      notes: 'Good one',
      focusRating: 4,
      plannedMinutes: 30,
    });
    expect(res.body.data.session.durationMinutes).toBeGreaterThanOrEqual(25);
    expect(res.body.data.session.durationMinutes).toBeLessThan(25.5);
    const { startedAt, endedAt, durationMinutes } = res.body.data.session;
    const elapsed = (new Date(endedAt) - new Date(startedAt)) / 60000;
    expect(Math.abs(durationMinutes - elapsed)).toBeLessThanOrEqual(0.05 + 1e-9);

    const events = await ActivityLog.find({ user: userId, type: 'session_finished' });
    expect(events).toHaveLength(1);
    expect(events[0].metadata).toMatchObject({ durationMinutes, focusRating: 4 });
    expect(String(events[0].refId)).toBe(session.id);

    expect((await api('get', '/sessions/active', token)).body.data.session).toBeNull();
  });

  it('stop without a body keeps the notes from start', async () => {
    const { token } = await registerUser();
    const { session } = (await startSession(token, { notes: 'plan' })).body.data;
    const res = await request(app)
      .post(`${API}/sessions/${session.id}/stop`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.session).toMatchObject({ notes: 'plan', focusRating: null });
  });

  it('rejects stopping a session twice, and validates stop and start bodies', async () => {
    const { token } = await registerUser();
    const { session } = (await startSession(token)).body.data;

    expect((await stopSession(token, session.id, { focusRating: 6 })).status).toBe(400);
    expect((await stopSession(token, session.id, { focusRating: 0 })).status).toBe(400);
    expect((await stopSession(token, session.id, { focusRating: 2.5 })).status).toBe(400);
    expect((await stopSession(token, session.id)).status).toBe(200);

    const again = await stopSession(token, session.id);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('SESSION_NOT_ACTIVE');

    expect((await startSession(token, { plannedMinutes: 0 })).status).toBe(400);
    expect((await startSession(token, { plannedMinutes: 'a lot' })).status).toBe(400);
    expect((await stopSession(token, fakeId)).status).toBe(404);
    expect((await stopSession(token, 'nope')).status).toBe(400);
  });

  it('auto-closes an active session older than 12 hours as abandoned when starting a new one', async () => {
    const { id: userId, token } = await registerUser();
    const stale = (await startSession(token)).body.data.session;
    await backdate(stale.id, 13 * HOUR);

    const res = await startSession(token);
    expect(res.status).toBe(201);
    expect(res.body.data.abandonedSessions).toBe(1);
    expect(res.body.data.session.id).not.toBe(stale.id);

    const closed = await StudySession.findById(stale.id);
    expect(closed).toMatchObject({ status: 'abandoned', durationMinutes: 0 });
    expect(closed.endedAt).toBeInstanceOf(Date);
    expect(await StudySession.countDocuments({ user: userId, status: 'active' })).toBe(1);

    // It no longer counts as study time.
    const stats = await api('get', '/sessions/stats', token);
    expect(stats.body.data.totalMinutes).toBe(0);
  });

  it('does not close a session younger than 12 hours', async () => {
    const { token } = await registerUser();
    const young = (await startSession(token)).body.data.session;
    await backdate(young.id, 11 * HOUR);

    expect((await startSession(token)).status).toBe(409);
    expect((await StudySession.findById(young.id)).status).toBe('active');
  });

  it('does not close a stale session when the new request is invalid', async () => {
    const { token } = await registerUser();
    const stale = (await startSession(token)).body.data.session;
    await backdate(stale.id, 13 * HOUR);

    expect((await startSession(token, { task: fakeId })).status).toBe(404);
    expect((await StudySession.findById(stale.id)).status).toBe('active');
  });

  it('lists sessions newest first, filtered by date range and topic', async () => {
    const { id: userId, token } = await registerUser();
    const subject = await createSubject(token);
    const topic = await createTopic(token, subject.id);

    const make = (daysAgo, extra = {}) =>
      StudySession.create({
        user: userId,
        startedAt: new Date(Date.now() - daysAgo * DAY),
        endedAt: new Date(Date.now() - daysAgo * DAY + 30 * 60000),
        durationMinutes: 30,
        status: 'completed',
        ...extra,
      });
    const old = await make(10);
    const mid = await make(5, { topic: topic.id });
    const recent = await make(1);

    const ids = async (query) =>
      (await api('get', `/sessions${query}`, token)).body.data.items.map((s) => s.id);

    expect(await ids('')).toEqual([recent.id, mid.id, old.id]);
    expect(await ids(`?topic=${topic.id}`)).toEqual([mid.id]);
    expect(await ids(`?from=${iso(-6 * DAY)}`)).toEqual([recent.id, mid.id]);
    expect(await ids(`?from=${iso(-6 * DAY)}&to=${iso(-2 * DAY)}`)).toEqual([mid.id]);

    const page = await api('get', '/sessions?limit=2', token);
    expect(page.body.data).toMatchObject({ page: 1, limit: 2, total: 3 });

    expect((await api('get', '/sessions?from=nope', token)).status).toBe(400);
    expect((await api('get', '/sessions?topic=nope', token)).status).toBe(400);
    expect((await api('get', `/sessions?from=${iso()}&to=${iso(-DAY)}`, token)).status).toBe(400);
  });

  it('updates the learning profile stats on start and stop', async () => {
    const { id: userId, token } = await registerUser();
    await Profile.create({ user: userId, academicLevel: 'other' });

    const { session } = (await startSession(token)).body.data;
    let profile = await Profile.findOne({ user: userId });
    expect(profile.learnedStats.mostActiveHour).toBe(new Date().getUTCHours());
    expect(profile.learnedStats.lastComputedAt).toBeInstanceOf(Date);

    await backdate(session.id, 20 * 60 * 1000);
    await stopSession(token, session.id);
    profile = await Profile.findOne({ user: userId });
    expect(profile.learnedStats.avgSessionMinutes).toBeGreaterThanOrEqual(20);
    expect(profile.learnedStats.avgSessionMinutes).toBeLessThan(21);
  });

  it('does not fail when the user has no profile yet', async () => {
    const { token } = await registerUser();
    const { session } = (await startSession(token)).body.data;
    expect((await stopSession(token, session.id)).status).toBe(200);
  });
});

describe('session stats', () => {
  it('reports totals, average, minutes per subject and per day', async () => {
    const { id: userId, token } = await registerUser();
    const math = await createSubject(token, 'Math');
    const art = await createSubject(token, 'Art');
    const calculus = await createTopic(token, math.id, 'Calculus');
    const algebra = await createTopic(token, math.id, 'Algebra');
    const color = await createTopic(token, art.id, 'Color');

    const make = (daysAgo, minutes, extra = {}) =>
      StudySession.create({
        user: userId,
        // Just after midnight UTC, so "today" is never in the future.
        startedAt: new Date(startOfUtcDay(new Date()).getTime() - daysAgo * DAY + 1000),
        endedAt: new Date(),
        durationMinutes: minutes,
        status: 'completed',
        ...extra,
      });

    await make(0, 30, { topic: calculus.id });
    await make(0, 20, { topic: algebra.id });
    await make(2, 40, { topic: color.id });
    await make(3, 10); // no topic
    await make(10, 60, { topic: calculus.id }); // outside the week, inside the month
    await make(1, 99, { status: 'abandoned' }); // never counts

    const week = (await api('get', '/sessions/stats?range=week', token)).body.data;
    expect(week).toMatchObject({
      range: 'week',
      totalMinutes: 100,
      sessionCount: 4,
      averageMinutes: 25,
    });
    expect(week.minutesPerSubject).toEqual([
      { subjectId: math.id, name: 'Math', minutes: 50 },
      { subjectId: art.id, name: 'Art', minutes: 40 },
      { subjectId: null, name: 'Unassigned', minutes: 10 },
    ]);
    expect(week.minutesPerDay).toHaveLength(7);
    const day = (n) => toDateKey(new Date(Date.now() - n * DAY));
    expect(week.minutesPerDay.at(-1)).toEqual({ date: day(0), minutes: 50 });
    expect(week.minutesPerDay.find((d) => d.date === day(2)).minutes).toBe(40);
    expect(week.minutesPerDay.find((d) => d.date === day(1)).minutes).toBe(0);

    const month = (await api('get', '/sessions/stats?range=month', token)).body.data;
    expect(month).toMatchObject({
      range: 'month',
      totalMinutes: 160,
      sessionCount: 5,
      averageMinutes: 32,
    });
    expect(month.minutesPerDay).toHaveLength(30);
    expect(month.minutesPerSubject[0]).toEqual({ subjectId: math.id, name: 'Math', minutes: 110 });

    // Default range is week.
    expect((await api('get', '/sessions/stats', token)).body.data.range).toBe('week');
  });

  it('is all zeros with no sessions and validates the range', async () => {
    const { token } = await registerUser();
    const res = await api('get', '/sessions/stats', token);
    expect(res.body.data).toMatchObject({
      totalMinutes: 0,
      sessionCount: 0,
      averageMinutes: 0,
      minutesPerSubject: [],
    });
    expect(res.body.data.minutesPerDay.every((d) => d.minutes === 0)).toBe(true);
    expect((await api('get', '/sessions/stats?range=year', token)).status).toBe(400);
  });
});

describe('ownership isolation', () => {
  const setup = async () => {
    const a = await registerUser('ada@example.com');
    const b = await registerUser('bob@example.com');
    const plan = await createPlan(a.token, { title: 'Ada plan' });
    const planTask = await createPlanTask(a.token, plan.id, { title: 'Ada plan task' });
    const task = await createTask(a.token, { title: 'Ada task', dueDate: at(1) });
    const session = (await startSession(a.token)).body.data.session;
    return { a, b, plan, planTask, task, session };
  };

  it("returns 404 for another user's plans, tasks and sessions", async () => {
    const { a, b, plan, planTask, task, session } = await setup();

    const attempts = [
      ['get', `/plans/${plan.id}`],
      ['patch', `/plans/${plan.id}`, { title: 'hacked' }],
      ['delete', `/plans/${plan.id}`],
      ['get', `/plans/${plan.id}/tasks`],
      ['post', `/plans/${plan.id}/tasks`, { title: 'injected' }],
      ['get', `/tasks/${task.id}`],
      ['get', `/tasks/${planTask.id}`],
      ['patch', `/tasks/${task.id}`, { title: 'hacked' }],
      ['patch', `/tasks/${task.id}/complete`],
      ['patch', `/tasks/${task.id}/reopen`],
      ['delete', `/tasks/${task.id}`],
      ['post', `/sessions/${session.id}/stop`, {}],
    ];
    for (const [method, path, body] of attempts) {
      const res = await api(method, path, b.token, body);
      expect([method, path, res.status]).toEqual([method, path, 404]);
    }

    // Nothing leaks into lists, upcoming, stats or active.
    expect((await api('get', '/plans', b.token)).body.data.total).toBe(0);
    expect((await api('get', '/tasks', b.token)).body.data.total).toBe(0);
    expect((await api('get', '/sessions', b.token)).body.data.total).toBe(0);
    const upcoming = (await api('get', '/tasks/upcoming?range=month', b.token)).body.data;
    expect(upcoming.groups).toEqual([]);
    expect(upcoming.overdue).toEqual([]);
    expect((await api('get', '/sessions/active', b.token)).body.data.session).toBeNull();
    expect((await api('get', '/planner/suggestions', b.token)).body.data.total).toBe(0);

    // And nothing changed for the owner.
    expect((await StudyPlan.findById(plan.id)).title).toBe('Ada plan');
    expect((await Task.findById(task.id)).status).toBe('todo');
    expect(await Task.countDocuments({ plan: plan.id })).toBe(1);
    expect((await StudySession.findById(session.id)).status).toBe('active');
    expect((await api('get', `/plans/${plan.id}`, a.token)).status).toBe(200);
  });
});

describe('referenced ids', () => {
  const setup = async () => {
    const a = await registerUser('ada@example.com');
    const b = await registerUser('bob@example.com');
    const mine = await createSubject(a.token, 'Mine');
    const myTopic = await createTopic(a.token, mine.id);
    const theirs = await createSubject(b.token, 'Theirs');
    const theirTopic = await createTopic(b.token, theirs.id);
    const theirPlan = await createPlan(b.token);
    const theirTask = await createTask(b.token);
    return { a, b, mine, myTopic, theirs, theirTopic, theirPlan, theirTask };
  };

  it("rejects another user's subject, topic and plan on tasks (404, naming the field)", async () => {
    const { a, theirs, theirTopic, theirPlan, myTopic } = await setup();

    const subject = await api('post', '/tasks', a.token, { title: 't', subject: theirs.id });
    expect(subject.status).toBe(404);
    expect(subject.body.error.code).toBe('SUBJECT_NOT_FOUND');
    expect(subject.body.error.details[0].field).toBe('subject');

    const topic = await api('post', '/tasks', a.token, { title: 't', topic: theirTopic.id });
    expect(topic.status).toBe(404);
    expect(topic.body.error.code).toBe('TOPIC_NOT_FOUND');
    expect(topic.body.error.details[0].field).toBe('topic');

    expect(
      (await api('post', `/plans/${theirPlan.id}/tasks`, a.token, { title: 't' })).status,
    ).toBe(404);

    const mine = await createTask(a.token);
    expect(
      (await api('patch', `/tasks/${mine.id}`, a.token, { topic: theirTopic.id })).status,
    ).toBe(404);
    expect((await api('patch', `/tasks/${mine.id}`, a.token, { subject: theirs.id })).status).toBe(
      404,
    );
    const move = await api('patch', `/tasks/${mine.id}`, a.token, { plan: theirPlan.id });
    expect(move.status).toBe(404);
    expect(move.body.error.code).toBe('PLAN_NOT_FOUND');

    expect((await Task.findById(mine.id)).toObject()).toMatchObject({ plan: null, topic: null });
    expect(await Task.countDocuments({ user: a.id })).toBe(1);
    // Own topic still works.
    expect((await api('patch', `/tasks/${mine.id}`, a.token, { topic: myTopic.id })).status).toBe(
      200,
    );
  });

  it('rejects unknown ids (404) and malformed ids (400)', async () => {
    const { a } = await setup();
    expect((await api('post', '/tasks', a.token, { title: 't', topic: fakeId })).status).toBe(404);
    expect((await api('post', '/tasks', a.token, { title: 't', subject: fakeId })).status).toBe(
      404,
    );
    expect((await api('post', '/tasks', a.token, { title: 't', topic: 'nope' })).status).toBe(400);
    expect((await api('post', '/plans', a.token, { title: 't', subjects: ['nope'] })).status).toBe(
      400,
    );
    expect((await startSession(a.token, { topic: 'nope' })).status).toBe(400);
    expect((await api('post', '/plans', a.token, { title: 't', subjects: [fakeId] })).status).toBe(
      404,
    );
  });

  it("rejects another user's subjects on plans, on create and update", async () => {
    const { a, mine, theirs } = await setup();

    const create = await api('post', '/plans', a.token, {
      title: 'p',
      subjects: [mine.id, theirs.id],
    });
    expect(create.status).toBe(404);
    expect(create.body.error.details[0].field).toBe('subjects');
    expect(await StudyPlan.countDocuments({ user: a.id })).toBe(0);

    const plan = await createPlan(a.token, { subjects: [mine.id] });
    const update = await api('patch', `/plans/${plan.id}`, a.token, { subjects: [theirs.id] });
    expect(update.status).toBe(404);
    expect((await StudyPlan.findById(plan.id)).subjects.map(String)).toEqual([mine.id]);

    const dup = await api('post', '/plans', a.token, { title: 'p', subjects: [mine.id, mine.id] });
    expect(dup.status).toBe(400);
  });

  it("rejects another user's task and topic when starting a session", async () => {
    const { a, theirTopic, theirTask } = await setup();
    expect((await startSession(a.token, { topic: theirTopic.id })).status).toBe(404);
    expect((await startSession(a.token, { task: theirTask.id })).status).toBe(404);
    expect(await StudySession.countDocuments({ user: a.id })).toBe(0);
  });

  it('checks that the topic belongs to the subject, and derives the subject from the topic', async () => {
    const a = await registerUser();
    const math = await createSubject(a.token, 'Math');
    const art = await createSubject(a.token, 'Art');
    const calculus = await createTopic(a.token, math.id, 'Calculus');

    const mismatch = await api('post', '/tasks', a.token, {
      title: 't',
      subject: art.id,
      topic: calculus.id,
    });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error.code).toBe('TOPIC_SUBJECT_MISMATCH');

    const derived = await createTask(a.token, { topic: calculus.id });
    expect(derived).toMatchObject({ topic: calculus.id, subject: math.id });

    // Changing only the topic re-derives the subject; changing only the subject must match the topic.
    const other = await createTopic(a.token, art.id, 'Color');
    const moved = await api('patch', `/tasks/${derived.id}`, a.token, { topic: other.id });
    expect(moved.body.data.task).toMatchObject({ topic: other.id, subject: art.id });
    expect((await api('patch', `/tasks/${derived.id}`, a.token, { subject: math.id })).status).toBe(
      400,
    );
    const cleared = await api('patch', `/tasks/${derived.id}`, a.token, { topic: null });
    expect(cleared.body.data.task).toMatchObject({ topic: null, subject: art.id });
  });

  it('does not require references to still exist when editing unrelated fields', async () => {
    const a = await registerUser();
    const subject = await createSubject(a.token);
    const topic = await createTopic(a.token, subject.id);
    const task = await createTask(a.token, { topic: topic.id });
    await Topic.deleteOne({ _id: topic.id });
    expect(
      (await api('patch', `/tasks/${task.id}`, a.token, { title: 'still editable' })).status,
    ).toBe(200);
  });
});

describe('suggestions', () => {
  it('suggests tasks due soon, due flashcards, mistakes and stale topics, each with a reason', async () => {
    const { token } = await registerUser();
    const subject = await createSubject(token);
    const flashTopic = await createTopic(token, subject.id, 'Flash topic');
    const mistakeTopic = await createTopic(token, subject.id, 'Mistake topic');
    const staleTopic = await createTopic(token, subject.id, 'Stale topic');
    const freshTopic = await createTopic(token, subject.id, 'Fresh topic');
    const doneTopic = await createTopic(token, subject.id, 'Done topic', { status: 'completed' });

    // Topics created 10 days ago, except the fresh one.
    const oldIds = [staleTopic, mistakeTopic, flashTopic, doneTopic].map(
      (t) => new mongoose.Types.ObjectId(t.id),
    );
    await Topic.collection.updateMany(
      { _id: { $in: oldIds } },
      { $set: { createdAt: new Date(Date.now() - 10 * DAY) } },
    );

    const dueSoon = await createTask(token, {
      title: 'Hand in essay',
      dueDate: iso(2 * HOUR),
      priority: 'high',
    });
    await createTask(token, { title: 'Far away', dueDate: iso(10 * DAY) });
    await createTask(token, { title: 'No date' });
    const finished = await createTask(token, { title: 'Finished', dueDate: iso(HOUR) });
    await complete(token, finished.id);
    const overdue = await createTask(token, { title: 'Late', dueDate: at(-2) });

    await createCard(token, flashTopic.id);
    await createCard(token, flashTopic.id, { front: 'Q2', back: 'A2' });

    const quiz = await createQuiz(token, mistakeTopic.id);
    await submit(token, quiz.id, answerAll(quiz, [false, false, false]));

    const res = await api('get', '/planner/suggestions', token);
    expect(res.status).toBe(200);
    const { items, total } = res.body.data;
    expect(total).toBe(items.length);
    expect(items.every((s) => typeof s.reason === 'string' && s.reason.length > 0)).toBe(true);

    const byKind = (kind) => items.filter((s) => s.kind === kind);

    expect(byKind('task_due_soon').map((s) => s.title)).toEqual(['Late', 'Hand in essay']);
    expect(byKind('task_due_soon')[0]).toMatchObject({ taskId: overdue.id });
    expect(byKind('task_due_soon')[0].reason).toMatch(/overdue/i);
    expect(byKind('task_due_soon')[1]).toMatchObject({ taskId: dueSoon.id, priority: 'high' });

    expect(byKind('flashcards_due')).toHaveLength(1);
    expect(byKind('flashcards_due')[0]).toMatchObject({
      topicId: flashTopic.id,
      subjectId: subject.id,
      type: 'revise',
      reason: '2 flashcards due for review today',
    });

    expect(byKind('unresolved_mistakes')).toHaveLength(1);
    expect(byKind('unresolved_mistakes')[0]).toMatchObject({
      topicId: mistakeTopic.id,
      type: 'practice',
      reason: '3 unresolved mistakes in your notebook',
    });

    // Submitting the quiz counts as studying the mistake topic, so it is not stale.
    const staleIds = byKind('stale_topic').map((s) => s.topicId);
    expect(staleIds.sort()).toEqual([staleTopic.id, flashTopic.id].sort());
    expect(staleIds).not.toContain(mistakeTopic.id);
    expect(staleIds).not.toContain(freshTopic.id);
    expect(staleIds).not.toContain(doneTopic.id);
    expect(byKind('stale_topic')[0].reason).toMatch(/never studied/i);

    // Most urgent kinds come first.
    const order = ['task_due_soon', 'flashcards_due', 'unresolved_mistakes', 'stale_topic'];
    const kinds = items.map((s) => order.indexOf(s.kind));
    expect(kinds).toEqual([...kinds].sort((x, y) => x - y));
  });

  it('does not suggest a topic that was studied recently', async () => {
    const { id: userId, token } = await registerUser();
    const subject = await createSubject(token);
    const bySession = await createTopic(token, subject.id, 'By session');
    const byActivity = await createTopic(token, subject.id, 'By activity');
    const longAgo = await createTopic(token, subject.id, 'Long ago');
    await Topic.collection.updateMany({}, { $set: { createdAt: new Date(Date.now() - 30 * DAY) } });

    await StudySession.create({
      user: userId,
      topic: bySession.id,
      startedAt: new Date(Date.now() - 2 * DAY),
      endedAt: new Date(Date.now() - 2 * DAY + 600000),
      durationMinutes: 10,
      status: 'completed',
    });
    await ActivityLog.create({
      user: userId,
      type: 'lesson_opened',
      metadata: { topicId: byActivity.id },
    });
    await StudySession.create({
      user: userId,
      topic: longAgo.id,
      startedAt: new Date(Date.now() - 20 * DAY),
      endedAt: new Date(Date.now() - 20 * DAY + 600000),
      durationMinutes: 10,
      status: 'completed',
    });

    const { items } = (await api('get', '/planner/suggestions', token)).body.data;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'stale_topic', topicId: longAgo.id });
    expect(items[0].reason).toBe('Not studied for 20 days');
  });

  it('is empty for a new user, paginates and validates the query', async () => {
    const { token } = await registerUser();
    const empty = await api('get', '/planner/suggestions', token);
    expect(empty.body.data).toMatchObject({ items: [], page: 1, limit: 20, total: 0 });

    for (let i = 0; i < 3; i += 1) await createTask(token, { title: `T${i}`, dueDate: iso(HOUR) });
    const page = await api('get', '/planner/suggestions?limit=2&page=2', token);
    expect(page.body.data).toMatchObject({ page: 2, limit: 2, total: 3 });
    expect(page.body.data.items).toHaveLength(1);
    expect((await api('get', '/planner/suggestions?limit=0', token)).status).toBe(400);
  });
});
