import * as practiceService from './practice.service.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { sendSuccess } from '../../utils/response.js';

/* ---------------------------------- Quiz -------------------------------- */

export const createQuiz = asyncHandler(async (req, res) => {
  const quiz = await practiceService.createQuiz(req.user._id, req.params.topicId, req.body);
  sendSuccess(res, { quiz }, 'Quiz created', 201);
});

export const listQuizzes = asyncHandler(async (req, res) => {
  const result = await practiceService.listQuizzes(req.user._id, req.params.topicId, req.query);
  sendSuccess(res, result, 'Quizzes');
});

export const getQuiz = asyncHandler(async (req, res) => {
  const quiz = await practiceService.getQuizForTaking(req.user._id, req.params.id);
  sendSuccess(res, { quiz }, 'Quiz');
});

export const getQuizForEditing = asyncHandler(async (req, res) => {
  const quiz = await practiceService.getQuizForEditing(req.user._id, req.params.id);
  sendSuccess(res, { quiz }, 'Quiz with answers');
});

export const updateQuiz = asyncHandler(async (req, res) => {
  const quiz = await practiceService.updateQuiz(req.user._id, req.params.id, req.body);
  sendSuccess(res, { quiz }, 'Quiz updated');
});

export const deleteQuiz = asyncHandler(async (req, res) => {
  const result = await practiceService.deleteQuiz(req.user._id, req.params.id);
  sendSuccess(res, result, 'Quiz deleted');
});

/* ------------------------------ Submit / history ------------------------ */

export const submitQuiz = asyncHandler(async (req, res) => {
  const result = await practiceService.submitQuiz(req.user._id, req.params.id, req.body);
  sendSuccess(res, result, 'Quiz submitted', 201);
});

export const listAttempts = asyncHandler(async (req, res) => {
  const result = await practiceService.listAttempts(req.user._id, req.params.id, req.query);
  sendSuccess(res, result, 'Attempts');
});

export const getAttempt = asyncHandler(async (req, res) => {
  const result = await practiceService.getAttempt(req.user._id, req.params.id);
  sendSuccess(res, result, 'Attempt');
});

/* ------------------------------- Flashcards ----------------------------- */

export const createFlashcard = asyncHandler(async (req, res) => {
  const flashcard = await practiceService.createFlashcard(
    req.user._id,
    req.params.topicId,
    req.body,
  );
  sendSuccess(res, { flashcard }, 'Flashcard created', 201);
});

export const bulkCreateFlashcards = asyncHandler(async (req, res) => {
  const result = await practiceService.bulkCreateFlashcards(
    req.user._id,
    req.params.topicId,
    req.body,
  );
  sendSuccess(res, result, 'Flashcards created', 201);
});

export const listFlashcards = asyncHandler(async (req, res) => {
  const result = await practiceService.listFlashcards(req.user._id, req.params.topicId, req.query);
  sendSuccess(res, result, 'Flashcards');
});

export const listDueFlashcards = asyncHandler(async (req, res) => {
  const result = await practiceService.listDueFlashcards(req.user._id, req.query);
  sendSuccess(res, result, 'Due flashcards');
});

export const getFlashcardStats = asyncHandler(async (req, res) => {
  const stats = await practiceService.getFlashcardStats(req.user._id, req.query);
  sendSuccess(res, stats, 'Flashcard stats');
});

export const getFlashcard = asyncHandler(async (req, res) => {
  const flashcard = await practiceService.getFlashcard(req.user._id, req.params.id);
  sendSuccess(res, { flashcard }, 'Flashcard');
});

export const updateFlashcard = asyncHandler(async (req, res) => {
  const flashcard = await practiceService.updateFlashcard(req.user._id, req.params.id, req.body);
  sendSuccess(res, { flashcard }, 'Flashcard updated');
});

export const deleteFlashcard = asyncHandler(async (req, res) => {
  const result = await practiceService.deleteFlashcard(req.user._id, req.params.id);
  sendSuccess(res, result, 'Flashcard deleted');
});

export const reviewFlashcard = asyncHandler(async (req, res) => {
  const flashcard = await practiceService.reviewFlashcard(req.user._id, req.params.id, req.body);
  sendSuccess(res, { flashcard }, 'Flashcard reviewed');
});
