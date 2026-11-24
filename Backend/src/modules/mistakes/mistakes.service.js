import { Mistake, RESOLVE_STREAK } from './mistakes.model.js';
import { Quiz } from '../practice/practice.model.js';
import { Subject, Topic } from '../space/space.model.js';
import * as profileService from '../profile/profile.service.js';
import { ApiError } from '../../utils/ApiError.js';
import { logger } from '../../utils/logger.js';
import { paginate, pageResult } from '../../utils/pagination.js';

const isDuplicateKey = (err) => err?.code === 11000;

const getOwnedMistake = async (userId, mistakeId) => {
  const mistake = await Mistake.findOne({ _id: mistakeId, user: userId });
  if (!mistake) throw ApiError.notFound('Mistake not found', { code: 'MISTAKE_NOT_FOUND' });
  return mistake;
};

/**
 * Refreshes profile.learnedStats (including weakTopics). Never throws: the stats
 * are derived data and must not make the request that changed the mistakes fail.
 */
export const refreshLearnedStats = async (userId) => {
  try {
    await profileService.recomputeLearnedStats(userId);
  } catch (err) {
    logger.error('Failed to recompute learned stats', { error: err?.message });
  }
};

/* ------------------------- Recording (used on submit) ------------------- */

const recordWrongAnswer = async (userId, quiz, { question, answer }, now) => {
  const filter = { user: userId, quiz: quiz._id, questionId: question._id };
  const snapshot = {
    topic: quiz.topic,
    questionPrompt: question.prompt,
    userAnswer: answer,
    correctAnswer: question.correctAnswer,
    explanation: question.explanation,
    correctStreak: 0,
    resolved: false,
    resolvedAt: null,
    lastAttemptedAt: now,
  };

  const update = () =>
    Mistake.findOneAndUpdate(
      filter,
      { $inc: { retryCount: 1 }, $set: snapshot },
      { returnDocument: 'after' },
    );

  if (await update()) return 'repeated';

  try {
    await Mistake.create({ ...filter, ...snapshot });
    return 'created';
  } catch (err) {
    // A concurrent submit created it between our update and create: count this one as a retry.
    if (!isDuplicateKey(err)) throw err;
    await update();
    return 'repeated';
  }
};

/**
 * Applies the graded answers of one submit to the Mistake Notebook.
 * - wrong answer: create the Mistake, or (same user + quiz + question) bump
 *   retryCount, store the new answer, reset correctStreak and reopen it;
 * - correct answer on an unresolved Mistake: correctStreak + 1, resolved once the
 *   streak reaches RESOLVE_STREAK. Resolved mistakes and questions that were never
 *   wrong are left alone.
 * Unanswered questions are not passed in, so they never touch the notebook.
 *
 * @param {{ question, answer: string, isCorrect: boolean }[]} results answered questions only
 */
export const recordQuizResults = async (userId, quiz, results, now = new Date()) => {
  const summary = { created: 0, repeated: 0, resolved: 0 };

  for (const result of results.filter((r) => !r.isCorrect)) {
    const outcome = await recordWrongAnswer(userId, quiz, result, now);
    summary[outcome] += 1;
  }

  const correctIds = results.filter((r) => r.isCorrect).map((r) => r.question._id);
  if (correctIds.length) {
    const open = await Mistake.find({
      user: userId,
      quiz: quiz._id,
      questionId: { $in: correctIds },
      resolved: false,
    });

    for (const mistake of open) {
      mistake.correctStreak += 1;
      mistake.lastAttemptedAt = now;
      if (mistake.correctStreak >= RESOLVE_STREAK) {
        mistake.resolved = true;
        mistake.resolvedAt = now;
        summary.resolved += 1;
      }
      await mistake.save();
    }
  }

  return summary;
};

/* --------------------------------- Reads -------------------------------- */

/** Topic ids of a subject, or null when no subject filter is requested. */
const topicIdsOfSubject = async (userId, subjectId) =>
  subjectId ? Topic.distinct('_id', { user: userId, subject: subjectId }) : null;

/** Builds the filter shared by the list and practice endpoints. */
const buildFilter = async (userId, { topic, subject, resolved }) => {
  const filter = { user: userId };
  if (resolved !== undefined) filter.resolved = resolved;

  const subjectTopics = await topicIdsOfSubject(userId, subject);
  if (topic && subjectTopics) {
    // Both filters: the topic must belong to the subject.
    filter.topic = subjectTopics.some((id) => String(id) === topic.toLowerCase()) ? topic : null;
  } else if (topic) {
    filter.topic = topic;
  } else if (subjectTopics) {
    filter.topic = { $in: subjectTopics };
  }
  return filter;
};

export const listMistakes = async (userId, query) => {
  const filter = await buildFilter(userId, query);
  const { skip, limit } = paginate(query);

  const [items, total] = await Promise.all([
    Mistake.find(filter).sort({ lastAttemptedAt: -1, _id: -1 }).skip(skip).limit(limit),
    Mistake.countDocuments(filter),
  ]);
  return pageResult(items, query, total);
};

export const getMistake = (userId, mistakeId) => getOwnedMistake(userId, mistakeId);

/* -------------------------------- Writes -------------------------------- */

export const resolveMistake = async (userId, mistakeId) => {
  const mistake = await getOwnedMistake(userId, mistakeId);
  if (!mistake.resolved) {
    mistake.resolved = true;
    mistake.resolvedAt = new Date();
    await mistake.save();
    await refreshLearnedStats(userId);
  }
  return mistake;
};

export const unresolveMistake = async (userId, mistakeId) => {
  const mistake = await getOwnedMistake(userId, mistakeId);
  if (mistake.resolved) {
    mistake.resolved = false;
    mistake.resolvedAt = null;
    mistake.correctStreak = 0;
    await mistake.save();
    await refreshLearnedStats(userId);
  }
  return mistake;
};

/* -------------------------------- Practice ------------------------------ */

/**
 * A quiz-like set built from the user's unresolved mistakes (least recently
 * attempted first). Answers and explanations are never included. Each question
 * carries its `quizId`, so the answers go to POST /quizzes/:quizId/submit, which
 * updates the notebook.
 */
export const buildPracticeSet = async (userId, { topic, subject, limit }) => {
  const filter = await buildFilter(userId, { topic, subject, resolved: false });
  const mistakes = await Mistake.find(filter).sort({ lastAttemptedAt: 1, _id: 1 }).limit(limit);

  const quizzes = await Quiz.find({
    user: userId,
    _id: { $in: [...new Set(mistakes.map((m) => String(m.quiz)))] },
  });
  const quizById = new Map(quizzes.map((q) => [String(q._id), q]));

  const questions = [];
  for (const mistake of mistakes) {
    const question = quizById.get(String(mistake.quiz))?.questions.id(mistake.questionId);
    if (!question) continue;
    questions.push({
      mistakeId: String(mistake._id),
      quizId: String(mistake.quiz),
      topicId: String(mistake.topic),
      questionId: String(question._id),
      type: question.type,
      prompt: question.prompt,
      options: question.type === 'mcq' ? [...question.options] : undefined,
      points: question.points,
    });
  }

  return { title: 'Mistake practice', total: questions.length, questions };
};

/* ------------------------------- Weak topics ----------------------------- */

const suggestAction = (unresolvedCount, topicId) => {
  if (unresolvedCount >= 5) {
    return {
      type: 'review_lesson',
      message: 'Re-read the lesson for this topic, then practice your mistakes.',
      topicId,
    };
  }
  return {
    type: 'practice_mistakes',
    message:
      unresolvedCount === 1
        ? 'Retry the question you got wrong.'
        : 'Practice your mistakes for this topic.',
    topicId,
  };
};

export const getWeakTopics = async (userId, query) => {
  const { skip, limit } = paginate(query);
  const { rows, total } = await Mistake.rankWeakTopics(userId, { skip, limit });

  const topics = await Topic.find({ _id: { $in: rows.map((r) => r.topicId) }, user: userId });
  const subjects = await Subject.find({
    _id: { $in: topics.map((t) => t.subject) },
    user: userId,
  });
  const topicById = new Map(topics.map((t) => [String(t._id), t]));
  const subjectById = new Map(subjects.map((s) => [String(s._id), s]));

  const items = [];
  for (const row of rows) {
    const topic = topicById.get(String(row.topicId));
    const subject = topic && subjectById.get(String(topic.subject));
    if (!topic || !subject) continue;

    items.push({
      topic: { id: String(topic._id), title: topic.title, status: topic.status },
      subject: {
        id: String(subject._id),
        name: subject.name,
        color: subject.color,
        icon: subject.icon,
      },
      unresolvedCount: row.unresolvedCount,
      lastMistakeAt: row.lastMistakeAt,
      suggestedAction: suggestAction(row.unresolvedCount, String(topic._id)),
    });
  }

  return pageResult(items, query, total);
};
