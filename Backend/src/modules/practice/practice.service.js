import { Quiz, Attempt, Flashcard } from './practice.model.js';
import { Mistake } from '../mistakes/mistakes.model.js';
import * as mistakesService from '../mistakes/mistakes.service.js';
import { Lesson } from '../lessons/lessons.model.js';
import { getOwnedTopic } from '../space/space.service.js';
import { logActivity } from '../../services/activity.service.js';
import { scheduleReview } from '../../utils/spacedRepetition.js';
import { ApiError } from '../../utils/ApiError.js';
import { paginate, pageResult } from '../../utils/pagination.js';

const quizNotFound = () => ApiError.notFound('Quiz not found', { code: 'QUIZ_NOT_FOUND' });
const attemptNotFound = () => ApiError.notFound('Attempt not found', { code: 'ATTEMPT_NOT_FOUND' });
const flashcardNotFound = () =>
  ApiError.notFound('Flashcard not found', { code: 'FLASHCARD_NOT_FOUND' });

/* ------------------------------ Serializers ----------------------------- */

/**
 * Explicit whitelists, not "delete the secret fields": a field added to the schema
 * later never leaks into the take-the-quiz payload by accident.
 * Without answers, the explanation is hidden too because it usually gives the answer away.
 */
const serializeQuestion = (question, { includeAnswers }) => ({
  id: String(question._id),
  type: question.type,
  prompt: question.prompt,
  ...(question.type === 'mcq' ? { options: [...question.options] } : {}),
  points: question.points,
  ...(includeAnswers
    ? { correctAnswer: question.correctAnswer, explanation: question.explanation }
    : {}),
});

const quizHeader = (quiz) => ({
  id: String(quiz._id),
  user: String(quiz.user),
  topic: String(quiz.topic),
  title: quiz.title,
  description: quiz.description,
  timeLimitMinutes: quiz.timeLimitMinutes,
  createdAt: quiz.createdAt,
  updatedAt: quiz.updatedAt,
});

const totalPoints = (quiz) => quiz.questions.reduce((sum, q) => sum + q.points, 0);

const serializeQuiz = (quiz, { includeAnswers }) => ({
  ...quizHeader(quiz),
  questionCount: quiz.questions.length,
  totalPoints: totalPoints(quiz),
  questions: quiz.questions.map((q) => serializeQuestion(q, { includeAnswers })),
});

const serializeQuizSummary = (quiz) => ({
  ...quizHeader(quiz),
  questionCount: quiz.questions.length,
  totalPoints: totalPoints(quiz),
});

const serializeAttemptAnswer = (answer) => ({
  questionId: String(answer.questionId),
  answer: answer.answer,
  isCorrect: answer.isCorrect,
  pointsEarned: answer.pointsEarned,
});

const serializeAttempt = (attempt, { withAnswers = true } = {}) => ({
  id: String(attempt._id),
  user: String(attempt.user),
  quiz: String(attempt.quiz),
  topic: String(attempt.topic),
  score: attempt.score,
  maxScore: attempt.maxScore,
  percentage: attempt.percentage,
  durationSeconds: attempt.durationSeconds,
  createdAt: attempt.createdAt,
  ...(withAnswers ? { answers: attempt.answers.map(serializeAttemptAnswer) } : {}),
});

/* ------------------------------- Ownership ------------------------------ */

const getOwnedQuiz = async (userId, quizId) => {
  const quiz = await Quiz.findOne({ _id: quizId, user: userId });
  if (!quiz) throw quizNotFound();
  return quiz;
};

const getOwnedFlashcard = async (userId, flashcardId) => {
  const card = await Flashcard.findOne({ _id: flashcardId, user: userId });
  if (!card) throw flashcardNotFound();
  return card;
};

/* ---------------------------------- Quiz -------------------------------- */

export const createQuiz = async (userId, topicId, data) => {
  const topic = await getOwnedTopic(userId, topicId);
  const quiz = await Quiz.create({ ...data, user: userId, topic: topic._id });
  return serializeQuiz(quiz, { includeAnswers: true });
};

export const listQuizzes = async (userId, topicId, query) => {
  const topic = await getOwnedTopic(userId, topicId);
  const filter = { user: userId, topic: topic._id };
  const { skip, limit } = paginate(query);

  const [quizzes, total] = await Promise.all([
    Quiz.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit),
    Quiz.countDocuments(filter),
  ]);
  return pageResult(quizzes.map(serializeQuizSummary), query, total);
};

/** The quiz as a student sees it while taking it: no correct answers, no explanations. */
export const getQuizForTaking = async (userId, quizId) =>
  serializeQuiz(await getOwnedQuiz(userId, quizId), { includeAnswers: false });

/** Owner/editor view, with answers and explanations. */
export const getQuizForEditing = async (userId, quizId) =>
  serializeQuiz(await getOwnedQuiz(userId, quizId), { includeAnswers: true });

/**
 * PATCH. A new `questions` list replaces the old one. Questions sent with their `id`
 * keep it (and their Mistake Notebook entries); questions left out are removed along
 * with their mistakes.
 */
export const updateQuiz = async (userId, quizId, changes) => {
  const quiz = await getOwnedQuiz(userId, quizId);
  const { questions, ...fields } = changes;
  let removedIds = [];

  if (questions) {
    const existingIds = new Set(quiz.questions.map((q) => String(q._id)));
    const keptIds = questions.filter((q) => q.id).map((q) => q.id.toLowerCase());

    const unknown = keptIds.filter((id) => !existingIds.has(id));
    if (unknown.length || new Set(keptIds).size !== keptIds.length) {
      throw ApiError.badRequest('Question ids must belong to this quiz and be unique', {
        code: 'INVALID_QUESTION_ID',
        details: unknown.length ? { unknown } : null,
      });
    }

    removedIds = [...existingIds].filter((id) => !keptIds.includes(id));
    quiz.set(
      'questions',
      questions.map(({ id, ...question }) => (id ? { _id: id, ...question } : question)),
    );
  }

  quiz.set(fields);
  await quiz.save();

  if (removedIds.length) {
    await Mistake.deleteMany({ user: userId, quiz: quiz._id, questionId: { $in: removedIds } });
    await mistakesService.refreshLearnedStats(userId);
  }

  return serializeQuiz(quiz, { includeAnswers: true });
};

/** Deletes the quiz with its attempts and mistakes, and unlinks it from lessons. */
export const deleteQuiz = async (userId, quizId) => {
  const quiz = await getOwnedQuiz(userId, quizId);

  // Children first, parent last: if anything fails, the delete can simply be retried.
  const attempts = await Attempt.deleteMany({ user: userId, quiz: quiz._id });
  const mistakes = await Mistake.deleteMany({ user: userId, quiz: quiz._id });
  await Lesson.updateMany(
    { user: userId, exercises: quiz._id },
    { $pull: { exercises: quiz._id } },
  );
  await Quiz.deleteOne({ _id: quiz._id, user: userId });

  if (mistakes.deletedCount) await mistakesService.refreshLearnedStats(userId);

  return {
    id: String(quiz._id),
    deleted: { attempts: attempts.deletedCount, mistakes: mistakes.deletedCount },
  };
};

/* --------------------------------- Grading ------------------------------ */

const normalizeShort = (value) => String(value).trim().toLowerCase();

/**
 * Pure grading of a single answer.
 * - mcq: exact match with the correct option
 * - true_false: match with "true" / "false" (case does not matter)
 * - short_answer: trimmed, case-insensitive match against any accepted answer
 * An unanswered question (null / undefined) is never correct.
 */
export const isAnswerCorrect = (question, answer) => {
  if (answer === null || answer === undefined) return false;

  switch (question.type) {
    case 'mcq':
      return answer === question.correctAnswer;
    case 'true_false':
      return normalizeShort(answer) === question.correctAnswer;
    case 'short_answer': {
      const given = normalizeShort(answer);
      return []
        .concat(question.correctAnswer)
        .some((accepted) => normalizeShort(accepted) === given);
    }
    default:
      return false;
  }
};

const roundTo2 = (value) => Math.round(value * 100) / 100;

/**
 * Grades every question of the quiz. Questions missing from `submitted` score 0 and
 * are flagged `answered: false`.
 * @param {Map<string, string>} submitted questionId -> answer
 */
export const gradeQuiz = (quiz, submitted) => {
  const records = [];
  let score = 0;
  let maxScore = 0;

  for (const question of quiz.questions) {
    const answered = submitted.has(String(question._id));
    const answer = answered ? submitted.get(String(question._id)) : null;
    const isCorrect = isAnswerCorrect(question, answer);
    const pointsEarned = isCorrect ? question.points : 0;

    score += pointsEarned;
    maxScore += question.points;
    records.push({ question, answered, answer, isCorrect, pointsEarned });
  }

  return {
    records,
    score,
    maxScore,
    percentage: maxScore > 0 ? roundTo2((score / maxScore) * 100) : 0,
  };
};

/** Per-question feedback, including the correct answer and the explanation. */
const buildFeedback = (quiz, answerByQuestionId) =>
  quiz.questions.flatMap((question) => {
    const record = answerByQuestionId.get(String(question._id));
    if (!record) return [];
    return [
      {
        questionId: String(question._id),
        type: question.type,
        prompt: question.prompt,
        userAnswer: record.answer,
        answered: record.answer !== null,
        isCorrect: record.isCorrect,
        pointsEarned: record.pointsEarned,
        points: question.points,
        correctAnswer: question.correctAnswer,
        explanation: question.explanation,
      },
    ];
  });

/**
 * Grades a submission, stores the Attempt, updates the Mistake Notebook, logs
 * `quiz_submitted` and refreshes the learned stats (weak topics), all in this one call.
 *
 * Questions left out of `answers` score 0 but are not wrong answers: they do not create
 * mistakes or reset a streak (this is what lets a mistake-practice retry submit just
 * the questions it asked).
 */
export const submitQuiz = async (userId, quizId, { answers, durationSeconds = 0 }) => {
  const quiz = await getOwnedQuiz(userId, quizId);

  const validIds = new Set(quiz.questions.map((q) => String(q._id)));
  const submitted = new Map(answers.map((a) => [a.questionId.toLowerCase(), a.answer]));
  const unknown = [...submitted.keys()].filter((id) => !validIds.has(id));
  if (unknown.length) {
    throw ApiError.badRequest('Some answers refer to questions that are not in this quiz', {
      code: 'INVALID_QUESTION_ID',
      details: { unknown },
    });
  }

  const { records, score, maxScore, percentage } = gradeQuiz(quiz, submitted);

  const attempt = await Attempt.create({
    user: userId,
    quiz: quiz._id,
    topic: quiz.topic,
    answers: records.map((r) => ({
      questionId: r.question._id,
      answer: r.answer,
      isCorrect: r.isCorrect,
      pointsEarned: r.pointsEarned,
    })),
    score,
    maxScore,
    percentage,
    durationSeconds,
  });

  const mistakeSummary = await mistakesService.recordQuizResults(
    userId,
    quiz,
    records.filter((r) => r.answered),
  );

  await logActivity({
    user: userId,
    type: 'quiz_submitted',
    refId: attempt._id,
    refModel: 'Attempt',
    metadata: {
      quizId: String(quiz._id),
      topicId: String(quiz.topic),
      score,
      maxScore,
      percentage,
      durationSeconds,
    },
  });

  await mistakesService.refreshLearnedStats(userId);

  const answerByQuestionId = new Map(records.map((r) => [String(r.question._id), r]));
  return {
    attempt: serializeAttempt(attempt),
    feedback: buildFeedback(quiz, answerByQuestionId),
    mistakes: mistakeSummary,
  };
};

/* -------------------------------- Attempts ------------------------------ */

export const listAttempts = async (userId, quizId, query) => {
  const quiz = await getOwnedQuiz(userId, quizId);
  const filter = { user: userId, quiz: quiz._id };
  const { skip, limit } = paginate(query);

  const [attempts, total] = await Promise.all([
    Attempt.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit),
    Attempt.countDocuments(filter),
  ]);
  return pageResult(
    attempts.map((a) => serializeAttempt(a, { withAnswers: false })),
    query,
    total,
  );
};

export const getAttempt = async (userId, attemptId) => {
  const attempt = await Attempt.findOne({ _id: attemptId, user: userId });
  if (!attempt) throw attemptNotFound();

  const quiz = await Quiz.findOne({ _id: attempt.quiz, user: userId });
  const answerByQuestionId = new Map(attempt.answers.map((a) => [String(a.questionId), a]));

  return {
    attempt: serializeAttempt(attempt),
    // Reflects the quiz as it is now: questions deleted since then are not listed.
    feedback: quiz ? buildFeedback(quiz, answerByQuestionId) : [],
  };
};

/* ------------------------------- Flashcards ----------------------------- */

export const createFlashcard = async (userId, topicId, data) => {
  const topic = await getOwnedTopic(userId, topicId);
  return Flashcard.create({ ...data, user: userId, topic: topic._id });
};

export const bulkCreateFlashcards = async (userId, topicId, { cards }) => {
  const topic = await getOwnedTopic(userId, topicId);
  const created = await Flashcard.insertMany(
    cards.map((card) => ({ ...card, user: userId, topic: topic._id })),
  );
  return { items: created, count: created.length };
};

export const listFlashcards = async (userId, topicId, query) => {
  const topic = await getOwnedTopic(userId, topicId);
  const filter = { user: userId, topic: topic._id };
  const { skip, limit } = paginate(query);

  const [items, total] = await Promise.all([
    Flashcard.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit),
    Flashcard.countDocuments(filter),
  ]);
  return pageResult(items, query, total);
};

export const getFlashcard = (userId, flashcardId) => getOwnedFlashcard(userId, flashcardId);

export const updateFlashcard = async (userId, flashcardId, changes) => {
  const card = await getOwnedFlashcard(userId, flashcardId);
  card.set(changes);
  return card.save();
};

export const deleteFlashcard = async (userId, flashcardId) => {
  const card = await getOwnedFlashcard(userId, flashcardId);
  await Flashcard.deleteOne({ _id: card._id, user: userId });
  return { id: String(card._id) };
};

const scopeFilter = async (userId, topicId) => {
  const filter = { user: userId };
  if (topicId) filter.topic = (await getOwnedTopic(userId, topicId))._id;
  return filter;
};

/** Cards whose nextReview has passed, most overdue first. */
export const listDueFlashcards = async (userId, query) => {
  const filter = { ...(await scopeFilter(userId, query.topic)), nextReview: { $lte: new Date() } };
  const { skip, limit } = paginate(query);

  const [items, total] = await Promise.all([
    Flashcard.find(filter).sort({ nextReview: 1, _id: 1 }).skip(skip).limit(limit),
    Flashcard.countDocuments(filter),
  ]);
  return pageResult(items, query, total);
};

const endOfUtcDay = (date) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1) - 1);

/**
 * dueNow: nextReview <= now. dueToday: nextReview <= the end of today (UTC), so it
 * includes dueNow plus the cards that fall due later today. total: all cards.
 */
export const getFlashcardStats = async (userId, { topic } = {}) => {
  const base = await scopeFilter(userId, topic);
  const now = new Date();

  const [dueNow, dueToday, total] = await Promise.all([
    Flashcard.countDocuments({ ...base, nextReview: { $lte: now } }),
    Flashcard.countDocuments({ ...base, nextReview: { $lte: endOfUtcDay(now) } }),
    Flashcard.countDocuments(base),
  ]);
  return { dueNow, dueToday, total };
};

export const reviewFlashcard = async (userId, flashcardId, { rating }) => {
  const card = await getOwnedFlashcard(userId, flashcardId);
  const now = new Date();

  card.set({ ...scheduleReview(card, rating, now), lastReviewedAt: now });
  await card.save();

  await logActivity({
    user: userId,
    type: 'flashcard_reviewed',
    refId: card._id,
    refModel: 'Flashcard',
    metadata: {
      rating,
      topicId: String(card.topic),
      intervalDays: card.intervalDays,
      repetitions: card.repetitions,
      easeFactor: card.easeFactor,
    },
  });

  return card;
};
