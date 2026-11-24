import { Subject, Topic, Material } from './space.model.js';
import { materialSchema } from './space.validation.js';
import { Lesson } from '../lessons/lessons.model.js';
import { Quiz, Attempt, Flashcard } from '../practice/practice.model.js';
import { Mistake } from '../mistakes/mistakes.model.js';
import { ApiError } from '../../utils/ApiError.js';
import { logger } from '../../utils/logger.js';
import { paginate, pageResult } from '../../utils/pagination.js';
import { supportsTransactions, withOptionalTransaction } from '../../utils/transaction.js';

const isDuplicateKey = (err) => err?.code === 11000;

const subjectNameTaken = () =>
  ApiError.conflict('You already have a subject with this name', {
    code: 'SUBJECT_NAME_TAKEN',
    details: [{ field: 'name', message: 'Already in use' }],
  });

/* ----------------------------- Ownership ------------------------------- */

/** Returns the subject if it belongs to the user, otherwise 404 (never 403). */
export const getOwnedSubject = async (userId, subjectId) => {
  const subject = await Subject.findOne({ _id: subjectId, user: userId });
  if (!subject) {
    throw ApiError.notFound('Subject not found', { code: 'SUBJECT_NOT_FOUND' });
  }
  return subject;
};

/**
 * Returns the topic if it belongs to the user AND its parent subject still
 * belongs to the user, otherwise 404. Reused by the lessons module.
 */
export const getOwnedTopic = async (userId, topicId) => {
  const topic = await Topic.findOne({ _id: topicId, user: userId });
  const subjectOk = topic && (await Subject.exists({ _id: topic.subject, user: userId }));
  if (!topic || !subjectOk) {
    throw ApiError.notFound('Topic not found', { code: 'TOPIC_NOT_FOUND' });
  }
  return topic;
};

/* -------------------------------- Cascade ------------------------------ */

/**
 * Collections that hang off a topic. Add future models here (quizzes,
 * flashcards, ...) and they are removed whenever a topic or subject is deleted.
 */
const TOPIC_DEPENDENTS = [
  { key: 'lessons', model: Lesson },
  { key: 'materials', model: Material },
  { key: 'mistakes', model: Mistake },
  { key: 'attempts', model: Attempt },
  { key: 'quizzes', model: Quiz },
  { key: 'flashcards', model: Flashcard },
];

const deleteTopicDependents = async (userId, topicIds, session) => {
  // Lessons of other topics may list these quizzes as exercises: unlink them first.
  const quizIds = await Quiz.distinct('_id', { user: userId, topic: { $in: topicIds } }).session(
    session,
  );
  if (quizIds.length) {
    await Lesson.updateMany(
      { user: userId, exercises: { $in: quizIds } },
      { $pull: { exercises: { $in: quizIds } } },
      { session },
    );
  }

  const deleted = {};
  for (const { key, model } of TOPIC_DEPENDENTS) {
    const result = await model.deleteMany({ user: userId, topic: { $in: topicIds } }, { session });
    deleted[key] = result.deletedCount;
  }
  return deleted;
};

/**
 * Runs a cascading delete in a transaction when MongoDB supports it. On a
 * standalone server the work runs sequentially instead; `work` must therefore
 * delete children first and the parent last, so that a failure half way leaves
 * the parent in place and the request can simply be retried.
 */
const runCascade = async (label, work) => {
  try {
    return await withOptionalTransaction(work);
  } catch (err) {
    logger.error(`Cascade delete failed (${label})`, err);
    const retryHint = supportsTransactions()
      ? 'Nothing was deleted.'
      : 'Some of its contents may already have been removed; retrying is safe.';
    throw new ApiError(500, `Could not delete the ${label}. ${retryHint} Please try again.`, {
      code: 'CASCADE_DELETE_FAILED',
    });
  }
};

/* ------------------------------- Subjects ------------------------------ */

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const attachTopicCounts = async (subjects) => {
  const ids = subjects.map((s) => s._id);
  const rows = ids.length
    ? await Topic.aggregate([
        { $match: { subject: { $in: ids } } },
        {
          $group: {
            _id: '$subject',
            topicCount: { $sum: 1 },
            completedTopicCount: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          },
        },
      ])
    : [];
  const byId = new Map(rows.map((r) => [String(r._id), r]));

  return subjects.map((subject) => {
    const counts = byId.get(String(subject._id));
    return {
      ...subject.toJSON(),
      topicCount: counts?.topicCount ?? 0,
      completedTopicCount: counts?.completedTopicCount ?? 0,
    };
  });
};

export const createSubject = async (userId, data) => {
  try {
    const subject = await Subject.create({ ...data, user: userId });
    const [result] = await attachTopicCounts([subject]);
    return result;
  } catch (err) {
    if (isDuplicateKey(err)) throw subjectNameTaken();
    throw err;
  }
};

export const listSubjects = async (userId, query) => {
  const filter = { user: userId };
  if (query.archived !== undefined) filter.archived = query.archived;
  if (query.search) {
    const regex = new RegExp(escapeRegex(query.search), 'i');
    filter.$or = [{ name: regex }, { description: regex }];
  }

  const { skip, limit } = paginate(query);
  const [subjects, total] = await Promise.all([
    Subject.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit),
    Subject.countDocuments(filter),
  ]);

  return pageResult(await attachTopicCounts(subjects), query, total);
};

export const getSubject = async (userId, subjectId) => {
  const subject = await getOwnedSubject(userId, subjectId);
  const [result] = await attachTopicCounts([subject]);
  return result;
};

export const updateSubject = async (userId, subjectId, changes) => {
  let subject;
  try {
    subject = await Subject.findOneAndUpdate(
      { _id: subjectId, user: userId },
      { $set: changes },
      { returnDocument: 'after', runValidators: true },
    );
  } catch (err) {
    if (isDuplicateKey(err)) throw subjectNameTaken();
    throw err;
  }
  if (!subject) throw ApiError.notFound('Subject not found', { code: 'SUBJECT_NOT_FOUND' });

  const [result] = await attachTopicCounts([subject]);
  return result;
};

/** Deletes a subject with its topics, materials and lessons. */
export const deleteSubject = async (userId, subjectId) => {
  const subject = await getOwnedSubject(userId, subjectId);

  const deleted = await runCascade('subject', async (session) => {
    const topicIds = await Topic.distinct('_id', {
      subject: subject._id,
      user: userId,
    }).session(session);

    const dependents = await deleteTopicDependents(userId, topicIds, session);
    const topics = await Topic.deleteMany({ subject: subject._id, user: userId }, { session });
    await Subject.deleteOne({ _id: subject._id, user: userId }, { session });

    return { topics: topics.deletedCount, ...dependents };
  });

  return { id: String(subject._id), deleted };
};

/* -------------------------------- Topics ------------------------------- */

export const createTopic = async (userId, subjectId, data) => {
  await getOwnedSubject(userId, subjectId);

  // New topics go to the end of the subject's list.
  const last = await Topic.findOne({ subject: subjectId, user: userId })
    .sort({ order: -1 })
    .select('order');

  return Topic.create({ ...data, user: userId, subject: subjectId, order: (last?.order ?? 0) + 1 });
};

export const listTopics = async (userId, subjectId, query) => {
  await getOwnedSubject(userId, subjectId);

  const filter = { subject: subjectId, user: userId };
  if (query.status) filter.status = query.status;
  if (query.difficulty) filter.difficulty = query.difficulty;

  const { skip, limit } = paginate(query);
  const [items, total] = await Promise.all([
    Topic.find(filter).sort({ order: 1, _id: 1 }).skip(skip).limit(limit),
    Topic.countDocuments(filter),
  ]);
  return pageResult(items, query, total);
};

export const getTopic = (userId, topicId) => getOwnedTopic(userId, topicId);

export const updateTopic = async (userId, topicId, changes) => {
  const topic = await getOwnedTopic(userId, topicId);
  topic.set(changes);
  return topic.save();
};

/** Deletes a topic with its materials and lesson. */
export const deleteTopic = async (userId, topicId) => {
  const topic = await getOwnedTopic(userId, topicId);

  const deleted = await runCascade('topic', async (session) => {
    const dependents = await deleteTopicDependents(userId, [topic._id], session);
    await Topic.deleteOne({ _id: topic._id, user: userId }, { session });
    return dependents;
  });

  return { id: String(topic._id), deleted };
};

/**
 * Sets topic.order from the position in `topicIds`. The list must contain
 * every topic of the subject exactly once.
 */
export const reorderTopics = async (userId, subjectId, topicIds) => {
  await getOwnedSubject(userId, subjectId);

  const existing = await Topic.find({ subject: subjectId, user: userId }).select('_id');
  const existingIds = new Set(existing.map((t) => String(t._id)));
  const requested = topicIds.map((id) => id.toLowerCase());
  const requestedSet = new Set(requested);

  const unknown = requested.filter((id) => !existingIds.has(id));
  const missing = [...existingIds].filter((id) => !requestedSet.has(id));
  if (unknown.length || missing.length) {
    throw ApiError.badRequest('topicIds must list every topic of this subject exactly once', {
      code: 'INVALID_REORDER',
      details: { unknown, missing },
    });
  }

  await Topic.bulkWrite(
    requested.map((id, index) => ({
      updateOne: {
        filter: { _id: id, subject: subjectId, user: userId },
        update: { $set: { order: index + 1 } },
      },
    })),
  );

  return Topic.find({ subject: subjectId, user: userId }).sort({ order: 1, _id: 1 });
};

/* ------------------------------- Materials ----------------------------- */

const MATERIAL_TYPE_FIELDS = { note: ['content'], link: ['url'], file: ['fileUrl', 'mimeType'] };
const MATERIAL_COMMON_FIELDS = ['title', 'tags'];

export const createMaterial = async (userId, topicId, data) => {
  await getOwnedTopic(userId, topicId);
  return Material.create({ ...data, user: userId, topic: topicId });
};

export const listMaterials = async (userId, topicId, query) => {
  await getOwnedTopic(userId, topicId);

  const filter = { topic: topicId, user: userId };
  if (query.type) filter.type = query.type;

  const { skip, limit } = paginate(query);
  const [items, total] = await Promise.all([
    Material.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit),
    Material.countDocuments(filter),
  ]);
  return pageResult(items, query, total);
};

const getOwnedMaterial = async (userId, materialId) => {
  const material = await Material.findOne({ _id: materialId, user: userId });
  if (!material) throw ApiError.notFound('Material not found', { code: 'MATERIAL_NOT_FOUND' });
  return material;
};

export const getMaterial = (userId, materialId) => getOwnedMaterial(userId, materialId);

export const updateMaterial = async (userId, materialId, changes) => {
  const material = await getOwnedMaterial(userId, materialId);
  const { type: requestedType, ...fields } = changes;

  if (requestedType && requestedType !== material.type) {
    throw ApiError.badRequest("A material's type cannot be changed", {
      code: 'MATERIAL_TYPE_IMMUTABLE',
      details: [{ field: 'type', message: `Material is a ${material.type}` }],
    });
  }

  const allowed = [...MATERIAL_COMMON_FIELDS, ...MATERIAL_TYPE_FIELDS[material.type]];
  const notAllowed = Object.keys(fields).filter((key) => !allowed.includes(key));
  if (notAllowed.length) {
    throw ApiError.badRequest(`Fields not valid for a ${material.type} material`, {
      code: 'VALIDATION_ERROR',
      details: notAllowed.map((field) => ({
        field,
        message: `Not allowed for type "${material.type}"`,
      })),
    });
  }

  // Re-validate the merged document so the per-type rules still hold after the patch.
  const current = material.toObject();
  const merged = materialSchema.parse({
    type: material.type,
    title: current.title,
    tags: current.tags,
    content: current.content,
    url: current.url,
    fileUrl: current.fileUrl,
    mimeType: current.mimeType,
    ...fields,
  });

  material.set(merged);
  return material.save();
};

export const deleteMaterial = async (userId, materialId) => {
  const material = await getOwnedMaterial(userId, materialId);
  await Material.deleteOne({ _id: material._id, user: userId });
  return { id: String(material._id) };
};
