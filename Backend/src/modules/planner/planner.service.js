import mongoose from 'mongoose';
import { StudyPlan, Task, StudySession, TASK_STATUSES } from './planner.model.js';
import {
  MS_PER_DAY,
  MS_PER_HOUR,
  STALE_SESSION_HOURS,
  addDays,
  calculateProgress,
  computeDurationMinutes,
  endOfUtcDay,
  getRangeBounds,
  groupTasksByDate,
  nextOccurrenceDate,
  round1,
  startOfUtcDay,
  toDateKey,
} from './planner.helpers.js';
import { Subject, Topic } from '../space/space.model.js';
import { getOwnedSubject, getOwnedTopic } from '../space/space.service.js';
import { Flashcard } from '../practice/practice.model.js';
import { Mistake } from '../mistakes/mistakes.model.js';
import { ActivityLog } from '../activity-log/activity-log.model.js';
import * as profileService from '../profile/profile.service.js';
import { logActivity } from '../../services/activity.service.js';
import { ApiError } from '../../utils/ApiError.js';
import { logger } from '../../utils/logger.js';
import { paginate, pageResult } from '../../utils/pagination.js';

const OPEN_STATUSES = ['todo', 'in_progress'];

const isDuplicateKey = (err) => err?.code === 11000;

/** Aggregation pipelines do not cast ids, so make sure we pass real ObjectIds. */
const oid = (id) => new mongoose.Types.ObjectId(String(id));

/* ----------------------------- Ownership ------------------------------- */

const getOwnedPlan = async (userId, planId) => {
  const plan = await StudyPlan.findOne({ _id: planId, user: userId });
  if (!plan) throw ApiError.notFound('Study plan not found', { code: 'PLAN_NOT_FOUND' });
  return plan;
};

const getOwnedTask = async (userId, taskId) => {
  const task = await Task.findOne({ _id: taskId, user: userId });
  if (!task) throw ApiError.notFound('Task not found', { code: 'TASK_NOT_FOUND' });
  return task;
};

/** Re-throws a 404 from an ownership check with the offending body field attached. */
const inField = async (field, work) => {
  try {
    return await work();
  } catch (err) {
    if (err instanceof ApiError && err.statusCode === 404) {
      throw new ApiError(404, err.message, {
        code: err.code,
        details: [{ field, message: 'Not found' }],
      });
    }
    throw err;
  }
};

/** Every subject id must belong to the user, otherwise 404. */
const assertOwnedSubjects = async (userId, subjectIds) => {
  if (!subjectIds.length) return;
  const owned = await Subject.countDocuments({ _id: { $in: subjectIds }, user: userId });
  if (owned !== new Set(subjectIds.map(String)).size) {
    throw new ApiError(404, 'Subject not found', {
      code: 'SUBJECT_NOT_FOUND',
      details: [{ field: 'subjects', message: 'Not found' }],
    });
  }
};

/**
 * Validates a subject and/or topic reference (both must belong to the user, and the topic
 * must belong to the subject). A topic without a subject fills in the subject.
 * @returns {{ subject: ObjectId|null, topic: ObjectId|null }}
 */
const resolveSubjectAndTopic = async (userId, { subject, topic }) => {
  const subjectDoc = subject
    ? await inField('subject', () => getOwnedSubject(userId, subject))
    : null;
  const topicDoc = topic ? await inField('topic', () => getOwnedTopic(userId, topic)) : null;

  if (topicDoc && subjectDoc && String(topicDoc.subject) !== String(subjectDoc._id)) {
    throw ApiError.badRequest('The topic does not belong to the subject', {
      code: 'TOPIC_SUBJECT_MISMATCH',
      details: [{ field: 'topic', message: 'Not part of the given subject' }],
    });
  }

  return {
    subject: subjectDoc?._id ?? topicDoc?.subject ?? null,
    topic: topicDoc?._id ?? null,
  };
};

/** A recurring task needs a due date to repeat from, and `until` cannot precede it. */
const assertRecurrence = (dueDate, recurrence) => {
  if (!recurrence || recurrence.type === 'none') return;
  if (!dueDate) {
    throw ApiError.badRequest('A recurring task needs a due date', {
      code: 'RECURRENCE_NEEDS_DUE_DATE',
      details: [{ field: 'dueDate', message: 'Required when recurrence is daily or weekly' }],
    });
  }
  if (recurrence.until && recurrence.until < dueDate) {
    throw ApiError.badRequest('Recurrence end date is before the due date', {
      code: 'INVALID_RECURRENCE',
      details: [{ field: 'recurrence.until', message: 'Must not be before dueDate' }],
    });
  }
};

const normalizeRecurrence = (recurrence) => {
  if (!recurrence || recurrence.type === 'none') return { type: 'none', until: null };
  return { type: recurrence.type, until: recurrence.until ?? null };
};

/* --------------------------------- Plans ------------------------------- */

/** { total, todo, in_progress, done, skipped } for the tasks of a plan. */
const countPlanTasks = async (userId, planId) => {
  const rows = await Task.aggregate([
    { $match: { user: oid(userId), plan: oid(planId) } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  const counts = Object.fromEntries(TASK_STATUSES.map((status) => [status, 0]));
  for (const { _id, count } of rows) counts[_id] = count;
  return { total: Object.values(counts).reduce((a, b) => a + b, 0), ...counts };
};

/**
 * Recomputes and stores StudyPlan.progress from the plan's tasks. Does nothing without a
 * plan. Derived from scratch every time, so it is idempotent.
 * @returns {Promise<number|null>} the new progress
 */
export const recomputePlanProgress = async (userId, planId) => {
  if (!planId) return null;
  const counts = await countPlanTasks(userId, planId);
  const progress = calculateProgress(counts);
  await StudyPlan.updateOne({ _id: planId, user: userId }, { $set: { progress } });
  return progress;
};

export const createPlan = async (userId, data) => {
  const startDate = data.startDate ?? startOfUtcDay(new Date());
  if (data.targetDate && data.targetDate < startDate) {
    throw ApiError.badRequest('targetDate must not be before startDate', {
      code: 'INVALID_DATES',
      details: [{ field: 'targetDate', message: 'Must not be before startDate' }],
    });
  }
  const subjects = data.subjects ?? [];
  await assertOwnedSubjects(userId, subjects);

  return StudyPlan.create({ ...data, subjects, startDate, user: userId, progress: 0 });
};

export const listPlans = async (userId, query) => {
  const filter = { user: userId };
  if (query.status) filter.status = query.status;

  const { skip, limit } = paginate(query);
  const [plans, total] = await Promise.all([
    StudyPlan.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit),
    StudyPlan.countDocuments(filter),
  ]);
  return pageResult(plans, query, total);
};

/** The plan plus live task counts and progress. */
export const getPlan = async (userId, planId) => {
  const plan = await getOwnedPlan(userId, planId);
  const taskCounts = await countPlanTasks(userId, plan._id);
  return { ...plan.toJSON(), progress: calculateProgress(taskCounts), taskCounts };
};

export const updatePlan = async (userId, planId, changes) => {
  const plan = await getOwnedPlan(userId, planId);

  const startDate = 'startDate' in changes ? changes.startDate : plan.startDate;
  const targetDate = 'targetDate' in changes ? changes.targetDate : plan.targetDate;
  if (startDate && targetDate && targetDate < startDate) {
    throw ApiError.badRequest('targetDate must not be before startDate', {
      code: 'INVALID_DATES',
      details: [{ field: 'targetDate', message: 'Must not be before startDate' }],
    });
  }
  if (changes.subjects) await assertOwnedSubjects(userId, changes.subjects);

  plan.set(changes);
  await plan.save();
  return plan;
};

/** Deletes the plan and its tasks. Study sessions are kept but unlinked from those tasks. */
export const deletePlan = async (userId, planId) => {
  const plan = await getOwnedPlan(userId, planId);

  const taskIds = await Task.find({ user: userId, plan: plan._id }).distinct('_id');
  if (taskIds.length) {
    await StudySession.updateMany(
      { user: userId, task: { $in: taskIds } },
      { $set: { task: null } },
    );
    await Task.deleteMany({ user: userId, plan: plan._id });
  }
  await StudyPlan.deleteOne({ _id: plan._id, user: userId });

  return { id: String(plan._id), deletedTasks: taskIds.length };
};

/* --------------------------------- Tasks ------------------------------- */

/** Creates a task. `planId` is set for tasks created under /plans/:planId/tasks. */
export const createTask = async (userId, data, planId = null) => {
  const plan = planId ? await getOwnedPlan(userId, planId) : null;
  const refs = await resolveSubjectAndTopic(userId, data);
  const recurrence = normalizeRecurrence(data.recurrence);
  assertRecurrence(data.dueDate, recurrence);

  const task = await Task.create({
    ...data,
    ...refs,
    recurrence,
    plan: plan?._id ?? null,
    user: userId,
  });
  await recomputePlanProgress(userId, task.plan);
  return task;
};

/** With `planId`: the tasks of that plan. Without: standalone tasks (not tied to a plan). */
export const listTasks = async (userId, query, planId = null) => {
  if (planId) await getOwnedPlan(userId, planId);

  const filter = { user: userId, plan: planId ?? null };
  if (query.status) filter.status = query.status;
  if (query.priority) filter.priority = query.priority;
  if (query.topic) filter.topic = query.topic;
  if (query.dueFrom || query.dueTo) {
    filter.dueDate = {};
    if (query.dueFrom) filter.dueDate.$gte = query.dueFrom;
    if (query.dueTo) filter.dueDate.$lte = query.dueTo;
  }

  const { skip, limit } = paginate(query);
  const [tasks, total] = await Promise.all([
    Task.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit),
    Task.countDocuments(filter),
  ]);
  return pageResult(tasks, query, total);
};

export const getTask = (userId, taskId) => getOwnedTask(userId, taskId);

export const updateTask = async (userId, taskId, changes) => {
  const task = await getOwnedTask(userId, taskId);

  if (changes.status !== undefined && task.status === 'done') {
    throw ApiError.conflict('Reopen the task before changing its status', {
      code: 'TASK_ALREADY_DONE',
    });
  }

  const previousPlan = task.plan;
  const update = { ...changes };

  if (changes.plan) {
    const plan = await inField('plan', () => getOwnedPlan(userId, changes.plan));
    update.plan = plan._id;
  }

  if ('subject' in changes || 'topic' in changes) {
    // Changing the topic without naming a subject re-derives the subject from the new topic.
    const topic = 'topic' in changes ? changes.topic : task.topic;
    const subject =
      'subject' in changes ? changes.subject : 'topic' in changes && topic ? null : task.subject;
    Object.assign(update, await resolveSubjectAndTopic(userId, { subject, topic }));
  }

  const dueDate = 'dueDate' in changes ? changes.dueDate : task.dueDate;
  const recurrence =
    'recurrence' in changes ? normalizeRecurrence(changes.recurrence) : task.recurrence;
  if ('recurrence' in changes) update.recurrence = recurrence;
  assertRecurrence(dueDate, recurrence);

  task.set(update);
  await task.save();

  if ('plan' in changes || 'status' in changes) {
    await recomputePlanProgress(userId, task.plan);
    if (String(previousPlan ?? '') !== String(task.plan ?? '')) {
      await recomputePlanProgress(userId, previousPlan);
    }
  }
  return task;
};

export const deleteTask = async (userId, taskId) => {
  const task = await getOwnedTask(userId, taskId);
  await Task.deleteOne({ _id: task._id, user: userId });

  await Promise.all([
    StudySession.updateMany({ user: userId, task: task._id }, { $set: { task: null } }),
    Task.updateMany({ user: userId, nextOccurrence: task._id }, { $set: { nextOccurrence: null } }),
  ]);
  await recomputePlanProgress(userId, task.plan);
  return { id: String(task._id) };
};

/**
 * Marks a task done: sets status and completedAt, logs `task_completed`, spawns the next
 * occurrence of a recurring task and recomputes the plan's progress.
 *
 * Idempotent: completing a done task returns it unchanged (nothing is logged or created
 * twice), even for concurrent requests, because only one of them wins the status change.
 */
export const completeTask = async (userId, taskId) => {
  const task = await Task.findOneAndUpdate(
    { _id: taskId, user: userId, status: { $ne: 'done' } },
    { $set: { status: 'done', completedAt: new Date() } },
    { returnDocument: 'after' },
  );
  if (!task) {
    const existing = await getOwnedTask(userId, taskId);
    return { task: existing, nextTask: null, planProgress: null };
  }

  await logActivity({
    user: userId,
    type: 'task_completed',
    refId: task._id,
    refModel: 'Task',
    metadata: {
      taskId: String(task._id),
      planId: task.plan ? String(task.plan) : null,
      topicId: task.topic ? String(task.topic) : null,
      subjectId: task.subject ? String(task.subject) : null,
      taskType: task.type,
      estimatedMinutes: task.estimatedMinutes,
    },
  });

  let nextTask = null;
  const nextDueDate = task.nextOccurrence ? null : nextOccurrenceDate(task);
  if (nextDueDate) {
    nextTask = await Task.create({
      user: task.user,
      plan: task.plan,
      subject: task.subject,
      topic: task.topic,
      title: task.title,
      notes: task.notes,
      type: task.type,
      estimatedMinutes: task.estimatedMinutes,
      priority: task.priority,
      recurrence: task.recurrence,
      dueDate: nextDueDate,
      status: 'todo',
    });
    task.nextOccurrence = nextTask._id;
    await Task.updateOne({ _id: task._id }, { $set: { nextOccurrence: nextTask._id } });
  }

  const planProgress = await recomputePlanProgress(userId, task.plan);
  return { task, nextTask, planProgress };
};

/**
 * Reverts a done task to todo. The occurrence that completing it spawned is removed if it
 * is still untouched (todo); otherwise it is kept, and the link stays so that completing
 * the task again does not create a duplicate.
 */
export const reopenTask = async (userId, taskId) => {
  const task = await Task.findOneAndUpdate(
    { _id: taskId, user: userId, status: 'done' },
    { $set: { status: 'todo', completedAt: null } },
    { returnDocument: 'after' },
  );
  if (!task) {
    await getOwnedTask(userId, taskId);
    throw ApiError.conflict('Only a completed task can be reopened', { code: 'TASK_NOT_DONE' });
  }

  if (task.nextOccurrence) {
    const removed = await Task.findOneAndDelete({
      _id: task.nextOccurrence,
      user: userId,
      status: 'todo',
    });
    if (removed) {
      task.nextOccurrence = null;
      await Task.updateOne({ _id: task._id }, { $set: { nextOccurrence: null } });
    }
  }

  const planProgress = await recomputePlanProgress(userId, task.plan);
  return { task, planProgress };
};

const UPCOMING_LIMIT = 500;

/**
 * Tasks grouped by due date for the day / week (Mon-Sun) / month containing `date`
 * (default: now), all in UTC.
 *
 * - groups: tasks due in the window (skipped tasks excluded), one group per date.
 * - overdue: open (todo / in_progress) tasks due before today, whatever the window. They
 *   are listed only here, never also in a group.
 */
export const getUpcomingTasks = async (userId, { range, date }) => {
  const now = new Date();
  const { from, to } = getRangeBounds(range, date ?? now);
  const todayStart = startOfUtcDay(now);

  const [inRange, overdue] = await Promise.all([
    Task.find({ user: userId, dueDate: { $gte: from, $lt: to }, status: { $ne: 'skipped' } })
      .sort({ dueDate: 1, _id: 1 })
      .limit(UPCOMING_LIMIT),
    Task.find({ user: userId, status: { $in: OPEN_STATUSES }, dueDate: { $lt: todayStart } })
      .sort({ dueDate: 1, _id: 1 })
      .limit(UPCOMING_LIMIT),
  ]);

  const isOverdue = (task) => OPEN_STATUSES.includes(task.status) && task.dueDate < todayStart;

  return {
    range,
    from,
    to,
    groups: groupTasksByDate(inRange.filter((task) => !isOverdue(task))),
    overdue,
  };
};

/* ------------------------------- Sessions ------------------------------ */

/** Never throws: derived stats must not fail the request that triggered them. */
const refreshLearnedStats = async (userId) => {
  try {
    await profileService.recomputeLearnedStats(userId);
  } catch (err) {
    logger.error('Failed to recompute learned stats', { error: err?.message });
  }
};

export const startSession = async (userId, data) => {
  const task = data.task ? await inField('task', () => getOwnedTask(userId, data.task)) : null;
  const topicId = data.topic ?? task?.topic ?? null;
  const topic = topicId ? await inField('topic', () => getOwnedTopic(userId, topicId)) : null;

  const now = new Date();

  // Safeguard: a session left running for 12+ hours was forgotten, so close it as abandoned.
  // It has no reliable end time, so it records 0 minutes and is left out of the stats.
  const { modifiedCount: abandonedSessions } = await StudySession.updateMany(
    {
      user: userId,
      status: 'active',
      startedAt: { $lte: new Date(now.getTime() - STALE_SESSION_HOURS * MS_PER_HOUR) },
    },
    { $set: { status: 'abandoned', endedAt: now, durationMinutes: 0 } },
  );

  let session;
  try {
    session = await StudySession.create({
      user: userId,
      task: task?._id ?? null,
      topic: topic?._id ?? null,
      plannedMinutes: data.plannedMinutes ?? null,
      notes: data.notes ?? '',
      startedAt: now,
      status: 'active',
    });
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
    const active = await StudySession.findOne({ user: userId, status: 'active' });
    throw ApiError.conflict('You already have an active study session', {
      code: 'SESSION_ALREADY_ACTIVE',
      details: { sessionId: active ? String(active._id) : null },
    });
  }

  await logActivity({
    user: userId,
    type: 'session_started',
    refId: session._id,
    refModel: 'StudySession',
    metadata: {
      taskId: task ? String(task._id) : null,
      topicId: topic ? String(topic._id) : null,
      plannedMinutes: session.plannedMinutes,
    },
  });
  await refreshLearnedStats(userId);

  return { session, abandonedSessions };
};

export const stopSession = async (userId, sessionId, { notes, focusRating } = {}) => {
  const session = await StudySession.findOne({ _id: sessionId, user: userId });
  if (!session) throw ApiError.notFound('Session not found', { code: 'SESSION_NOT_FOUND' });

  const notActive = () =>
    ApiError.conflict('This session is not active', { code: 'SESSION_NOT_ACTIVE' });
  if (session.status !== 'active') throw notActive();

  const endedAt = new Date();
  const changes = {
    status: 'completed',
    endedAt,
    durationMinutes: computeDurationMinutes(session.startedAt, endedAt),
  };
  if (notes !== undefined) changes.notes = notes;
  if (focusRating !== undefined) changes.focusRating = focusRating;

  // Conditional on status so two concurrent stops cannot both finish (and log) the session.
  const stopped = await StudySession.findOneAndUpdate(
    { _id: session._id, user: userId, status: 'active' },
    { $set: changes },
    { returnDocument: 'after' },
  );
  if (!stopped) throw notActive();

  await logActivity({
    user: userId,
    type: 'session_finished',
    refId: stopped._id,
    refModel: 'StudySession',
    metadata: {
      durationMinutes: stopped.durationMinutes,
      plannedMinutes: stopped.plannedMinutes,
      focusRating: stopped.focusRating,
      taskId: stopped.task ? String(stopped.task) : null,
      topicId: stopped.topic ? String(stopped.topic) : null,
    },
  });
  await refreshLearnedStats(userId);

  return stopped;
};

/** The running session, or null. */
export const getActiveSession = (userId) =>
  StudySession.findOne({ user: userId, status: 'active' });

export const listSessions = async (userId, query) => {
  const filter = { user: userId };
  if (query.topic) filter.topic = query.topic;
  if (query.from || query.to) {
    filter.startedAt = {};
    if (query.from) filter.startedAt.$gte = query.from;
    if (query.to) filter.startedAt.$lte = query.to;
  }

  const { skip, limit } = paginate(query);
  const [sessions, total] = await Promise.all([
    StudySession.find(filter).sort({ startedAt: -1, _id: -1 }).skip(skip).limit(limit),
    StudySession.countDocuments(filter),
  ]);
  return pageResult(sessions, query, total);
};

const STATS_DAYS = { week: 7, month: 30 };

/**
 * Stats over the last 7 / 30 days (UTC days, including today). Only completed sessions
 * count; a session belongs to the day it started.
 * Sessions without a topic (or whose topic was deleted) are reported as "Unassigned".
 */
export const getSessionStats = async (userId, { range }) => {
  const now = new Date();
  const days = STATS_DAYS[range];
  const from = addDays(startOfUtcDay(now), -(days - 1));

  const sessions = await StudySession.find({
    user: userId,
    status: 'completed',
    startedAt: { $gte: from, $lte: now },
  })
    .select('topic startedAt durationMinutes')
    .lean();

  const minutesOf = (s) => s.durationMinutes ?? 0;
  const totalMinutes = sessions.reduce((sum, s) => sum + minutesOf(s), 0);

  const perDay = new Map();
  for (let i = 0; i < days; i += 1) perDay.set(toDateKey(addDays(from, i)), 0);
  for (const s of sessions) {
    const key = toDateKey(s.startedAt);
    perDay.set(key, (perDay.get(key) ?? 0) + minutesOf(s));
  }

  const topicIds = [...new Set(sessions.filter((s) => s.topic).map((s) => String(s.topic)))];
  const topics = topicIds.length
    ? await Topic.find({ _id: { $in: topicIds }, user: userId })
        .select('subject')
        .lean()
    : [];
  const subjectOfTopic = new Map(topics.map((t) => [String(t._id), String(t.subject)]));
  const subjects = subjectOfTopic.size
    ? await Subject.find({ _id: { $in: [...new Set(subjectOfTopic.values())] }, user: userId })
        .select('name')
        .lean()
    : [];
  const subjectNames = new Map(subjects.map((s) => [String(s._id), s.name]));

  const perSubject = new Map();
  for (const s of sessions) {
    const subjectId = s.topic ? (subjectOfTopic.get(String(s.topic)) ?? null) : null;
    const key = subjectNames.has(subjectId) ? subjectId : null;
    perSubject.set(key, (perSubject.get(key) ?? 0) + minutesOf(s));
  }

  return {
    range,
    from,
    to: now,
    totalMinutes: round1(totalMinutes),
    sessionCount: sessions.length,
    averageMinutes: sessions.length ? round1(totalMinutes / sessions.length) : 0,
    minutesPerSubject: [...perSubject.entries()]
      .map(([subjectId, minutes]) => ({
        subjectId,
        name: subjectId ? subjectNames.get(subjectId) : 'Unassigned',
        minutes: round1(minutes),
      }))
      .sort((a, b) => b.minutes - a.minutes),
    minutesPerDay: [...perDay.entries()].map(([date, minutes]) => ({
      date,
      minutes: round1(minutes),
    })),
  };
};

/* ----------------------------- Suggestions ----------------------------- */

/** A topic not studied for this many days is suggested for a refresher. */
export const STALE_TOPIC_DAYS = 7;
/** Open tasks due within this many hours (or overdue) are suggested. */
export const DUE_SOON_HOURS = 48;

const SUGGESTION_LIMITS = { dueSoon: 10, flashcards: 5, mistakes: 5, staleTopics: 5 };

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

const loadTopics = async (userId, topicIds) => {
  if (!topicIds.length) return new Map();
  const topics = await Topic.find({ _id: { $in: topicIds }, user: userId })
    .select('title subject')
    .lean();
  return new Map(topics.map((t) => [String(t._id), t]));
};

const describeDue = (dueDate, now) => {
  if (dueDate < startOfUtcDay(now)) return `Overdue: was due ${toDateKey(dueDate)}`;
  if (dueDate < now) return 'Overdue: was due earlier today';
  if (toDateKey(dueDate) === toDateKey(now)) return 'Due today';
  return `Due soon: ${toDateKey(dueDate)}`;
};

const tasksDueSoon = async (userId, now) => {
  const tasks = await Task.find({
    user: userId,
    status: { $in: OPEN_STATUSES },
    dueDate: { $ne: null, $lte: new Date(now.getTime() + DUE_SOON_HOURS * MS_PER_HOUR) },
  })
    .sort({ dueDate: 1, _id: 1 })
    .limit(SUGGESTION_LIMITS.dueSoon)
    .lean();

  return tasks.map((task) => ({
    kind: 'task_due_soon',
    title: task.title,
    type: task.type,
    reason: describeDue(task.dueDate, now),
    priority: task.priority,
    dueDate: task.dueDate,
    taskId: String(task._id),
    topicId: task.topic ? String(task.topic) : null,
    subjectId: task.subject ? String(task.subject) : null,
  }));
};

const flashcardsDueToday = async (userId, now) => {
  const rows = await Flashcard.aggregate([
    { $match: { user: oid(userId), nextReview: { $lte: endOfUtcDay(now) } } },
    { $group: { _id: '$topic', count: { $sum: 1 } } },
    { $sort: { count: -1, _id: 1 } },
    { $limit: SUGGESTION_LIMITS.flashcards },
  ]);
  const topics = await loadTopics(
    userId,
    rows.map((r) => r._id),
  );

  return rows
    .filter((row) => topics.has(String(row._id)))
    .map((row) => {
      const topic = topics.get(String(row._id));
      return {
        kind: 'flashcards_due',
        title: `Review flashcards: ${topic.title}`,
        type: 'revise',
        reason: `${plural(row.count, 'flashcard')} due for review today`,
        priority: 'high',
        dueDate: null,
        taskId: null,
        topicId: String(topic._id),
        subjectId: String(topic.subject),
      };
    });
};

const topicsWithMistakes = async (userId) => {
  const { rows } = await Mistake.rankWeakTopics(userId, { limit: SUGGESTION_LIMITS.mistakes });
  const topics = await loadTopics(
    userId,
    rows.map((r) => r.topicId),
  );

  return rows
    .filter((row) => topics.has(String(row.topicId)))
    .map((row) => {
      const topic = topics.get(String(row.topicId));
      return {
        kind: 'unresolved_mistakes',
        title: `Practice: ${topic.title}`,
        type: 'practice',
        reason: `${plural(row.unresolvedCount, 'unresolved mistake')} in your notebook`,
        priority: 'medium',
        dueDate: null,
        taskId: null,
        topicId: String(topic._id),
        subjectId: String(topic.subject),
      };
    });
};

const STUDY_EVENT_TYPES = [
  'lesson_opened',
  'lesson_completed',
  'quiz_submitted',
  'flashcard_reviewed',
];

/** Unfinished topics (in non-archived subjects) with no study activity for STALE_TOPIC_DAYS. */
const staleTopics = async (userId, now) => {
  const subjectIds = await Subject.find({ user: userId, archived: false }).distinct('_id');
  if (!subjectIds.length) return [];

  const topics = await Topic.find({
    user: userId,
    subject: { $in: subjectIds },
    status: { $ne: 'completed' },
  })
    .select('title subject createdAt')
    .lean();
  if (!topics.length) return [];

  const idStrings = topics.map((t) => String(t._id));
  const [sessionRows, eventRows] = await Promise.all([
    StudySession.aggregate([
      { $match: { user: oid(userId), topic: { $in: topics.map((t) => t._id) } } },
      { $group: { _id: '$topic', last: { $max: '$startedAt' } } },
    ]),
    ActivityLog.aggregate([
      {
        $match: {
          user: oid(userId),
          type: { $in: STUDY_EVENT_TYPES },
          'metadata.topicId': { $in: idStrings },
        },
      },
      { $group: { _id: '$metadata.topicId', last: { $max: '$createdAt' } } },
    ]),
  ]);

  const lastStudied = new Map();
  for (const { _id, last } of [...sessionRows, ...eventRows]) {
    const key = String(_id);
    if (!lastStudied.has(key) || lastStudied.get(key) < last) lastStudied.set(key, last);
  }

  const cutoff = new Date(now.getTime() - STALE_TOPIC_DAYS * MS_PER_DAY);
  return topics
    .map((topic) => {
      const last = lastStudied.get(String(topic._id)) ?? null;
      return { topic, last, since: last ?? topic.createdAt };
    })
    .filter(({ since }) => since < cutoff)
    .sort((a, b) => a.since - b.since || String(a.topic._id).localeCompare(String(b.topic._id)))
    .slice(0, SUGGESTION_LIMITS.staleTopics)
    .map(({ topic, last, since }) => {
      const days = Math.floor((now - since) / MS_PER_DAY);
      return {
        kind: 'stale_topic',
        title: `Study: ${topic.title}`,
        type: 'study',
        reason: last
          ? `Not studied for ${plural(days, 'day')}`
          : `Never studied (added ${plural(days, 'day')} ago)`,
        priority: 'low',
        dueDate: null,
        taskId: null,
        topicId: String(topic._id),
        subjectId: String(topic.subject),
      };
    });
};

/**
 * Rule-based suggestions (no AI), most urgent first: tasks due soon or overdue, flashcards
 * due today, topics with unresolved mistakes, topics not studied recently. Every suggestion
 * has a `reason`. The full list is small and capped, so it is built and then paginated.
 */
export const getSuggestions = async (userId, query) => {
  const now = new Date();
  const [dueSoon, flashcards, mistakes, stale] = await Promise.all([
    tasksDueSoon(userId, now),
    flashcardsDueToday(userId, now),
    topicsWithMistakes(userId),
    staleTopics(userId, now),
  ]);

  const all = [...dueSoon, ...flashcards, ...mistakes, ...stale];
  const { skip, limit } = paginate(query);
  return { ...pageResult(all.slice(skip, skip + limit), query, all.length), generatedAt: now };
};
