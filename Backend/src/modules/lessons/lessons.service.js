import { Lesson, LESSON_FORMATS } from './lessons.model.js';
import { Topic } from '../space/space.model.js';
import { Quiz } from '../practice/practice.model.js';
import { getOwnedTopic } from '../space/space.service.js';
import * as profileService from '../profile/profile.service.js';
import { logActivity } from '../../services/activity.service.js';
import { ApiError } from '../../utils/ApiError.js';
import { logger } from '../../utils/logger.js';

const lessonNotFound = () =>
  ApiError.notFound('This topic has no lesson yet', { code: 'LESSON_NOT_FOUND' });

/* ------------------------------- Formats ------------------------------- */

const EMPTY_FORMATS = { simplified: '', diagram: null, steps: [], examples: [] };

const isFormatPresent = (formats, key) => {
  const value = formats?.[key];
  if (key === 'simplified') return typeof value === 'string' && value.trim().length > 0;
  if (key === 'diagram') return Boolean(value?.source);
  return Array.isArray(value) && value.length > 0;
};

/** Names of the formats that have content, in canonical order. */
export const availableFormats = (lesson) =>
  LESSON_FORMATS.filter((key) => isFormatPresent(lesson.formats, key));

/** Lesson JSON limited to the given format keys (all by default). */
const serializeLesson = (lesson, keys = LESSON_FORMATS) => {
  const json = lesson.toJSON();
  const formats = {};
  for (const key of keys) formats[key] = json.formats?.[key] ?? EMPTY_FORMATS[key];
  return { ...json, formats };
};

/* ------------------------------- Helpers ------------------------------- */

const findLesson = async (userId, topicId) => {
  const lesson = await Lesson.findOne({ topic: topicId, user: userId });
  if (!lesson) throw lessonNotFound();
  return lesson;
};

/** Applies validated `formats` keys onto the document (diagram: null removes it). */
const applyFormats = (lesson, formats = {}) => {
  for (const [key, value] of Object.entries(formats)) {
    lesson.set(`formats.${key}`, value === null ? undefined : value);
  }
};

/* -------------------------------- Writes ------------------------------- */

/**
 * PUT: creates the lesson, or replaces its title and all formats (formats not
 * supplied become empty). Completion state and exercises are kept.
 * @returns {{ lesson, created: boolean }}
 */
export const putLesson = async (userId, topicId, { title, formats }) => {
  const topic = await getOwnedTopic(userId, topicId);
  const existing = await Lesson.findOne({ topic: topic._id, user: userId });

  if (!existing) {
    const lesson = await Lesson.create({ user: userId, topic: topic._id, title, formats });
    return { lesson: serializeLesson(lesson), created: true };
  }

  existing.title = title;
  existing.set('formats', {
    simplified: formats.simplified ?? '',
    diagram: formats.diagram ?? undefined,
    steps: formats.steps ?? [],
    examples: formats.examples ?? [],
  });
  await existing.save();
  return { lesson: serializeLesson(existing), created: false };
};

/**
 * Every id must be a quiz owned by the user. A quiz that does not exist and a quiz
 * owned by someone else are reported the same way, so ids of other users never leak.
 */
const assertOwnedQuizzes = async (userId, quizIds) => {
  if (!quizIds.length) return;
  const owned = await Quiz.find({ _id: { $in: quizIds }, user: userId }).select('_id');
  const ownedIds = new Set(owned.map((q) => String(q._id)));
  const unknown = quizIds.filter((id) => !ownedIds.has(id));
  if (unknown.length) {
    throw ApiError.badRequest('Some exercises are not quizzes of yours', {
      code: 'INVALID_EXERCISES',
      details: { unknown },
    });
  }
};

export const patchLesson = async (userId, topicId, { title, formats, exercises }) => {
  const topic = await getOwnedTopic(userId, topicId);
  const lesson = await findLesson(userId, topic._id);

  if (exercises !== undefined) {
    const quizIds = exercises.map((id) => id.toLowerCase());
    await assertOwnedQuizzes(userId, quizIds);
    lesson.exercises = quizIds;
  }

  if (title !== undefined) lesson.title = title;
  applyFormats(lesson, formats);
  await lesson.save();
  return serializeLesson(lesson);
};

export const deleteLesson = async (userId, topicId) => {
  const topic = await getOwnedTopic(userId, topicId);
  const lesson = await findLesson(userId, topic._id);
  await Lesson.deleteOne({ _id: lesson._id, user: userId });
  return { id: String(lesson._id) };
};

/* -------------------------------- Reads -------------------------------- */

export const getFormats = async (userId, topicId) => {
  const topic = await getOwnedTopic(userId, topicId);
  const lesson = await findLesson(userId, topic._id);
  const available = availableFormats(lesson);
  return {
    formats: Object.fromEntries(LESSON_FORMATS.map((key) => [key, available.includes(key)])),
    available,
  };
};

/**
 * Returns the lesson limited to `format` (or everything for "all").
 * A successful read moves the topic from not_started to in_progress. Reading a
 * specific format also logs `lesson_opened` and refreshes the learned stats in
 * the background (the response never waits for, or fails because of, the stats).
 */
export const openLesson = async (userId, topicId, format = 'all') => {
  const topic = await getOwnedTopic(userId, topicId);
  const lesson = await findLesson(userId, topic._id);
  const available = availableFormats(lesson);

  if (format !== 'all' && !available.includes(format)) {
    throw new ApiError(404, `This lesson has no "${format}" format`, {
      code: 'FORMAT_NOT_AVAILABLE',
      details: { requested: format, available },
    });
  }

  // Conditional update: only the first open changes anything.
  await Topic.updateOne(
    { _id: topic._id, user: userId, status: 'not_started' },
    { $set: { status: 'in_progress' } },
  );

  if (format !== 'all') {
    await logActivity({
      user: userId,
      type: 'lesson_opened',
      refId: lesson._id,
      refModel: 'Lesson',
      metadata: { format, topicId: String(topic._id), subjectId: String(topic.subject) },
    });

    profileService.recomputeLearnedStats(userId).catch((err) => {
      logger.error('Failed to recompute learned stats', { error: err?.message });
    });
  }

  return {
    format,
    availableFormats: available,
    lesson: serializeLesson(lesson, format === 'all' ? LESSON_FORMATS : [format]),
  };
};

/**
 * Marks the lesson and its topic as completed. Idempotent: `lesson_completed`
 * is only logged the first time.
 */
export const completeLesson = async (userId, topicId) => {
  const topic = await getOwnedTopic(userId, topicId);
  const lesson = await findLesson(userId, topic._id);

  const firstTime = !lesson.completed;
  if (firstTime) {
    lesson.completed = true;
    lesson.completedAt = new Date();
    await lesson.save();
  }

  await Topic.updateOne({ _id: topic._id, user: userId }, { $set: { status: 'completed' } });

  if (firstTime) {
    await logActivity({
      user: userId,
      type: 'lesson_completed',
      refId: lesson._id,
      refModel: 'Lesson',
      metadata: { topicId: String(topic._id), subjectId: String(topic.subject) },
    });
  }

  return { lesson: serializeLesson(lesson), topicStatus: 'completed' };
};
