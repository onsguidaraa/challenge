import mongoose from 'mongoose';
import { DEFAULT_EASE_FACTOR } from '../../utils/spacedRepetition.js';

export const QUESTION_TYPES = ['mcq', 'true_false', 'short_answer'];

const { ObjectId, Mixed } = mongoose.Schema.Types;

const toJSON = {
  transform: (_doc, ret) => {
    // Also runs for sub-documents.
    if (ret._id) {
      ret.id = String(ret._id);
      delete ret._id;
    }
    delete ret.__v;
    return ret;
  },
};

/* --------------------------------- Quiz -------------------------------- */

// Zod enforces the exact per-type rules; this schema is a second line of defense.
const questionSchema = new mongoose.Schema({
  type: { type: String, enum: QUESTION_TYPES, required: true },
  prompt: { type: String, required: true, trim: true, maxlength: 2000 },
  options: { type: [String], default: undefined },
  // string (mcq, true_false, short_answer) or string[] (accepted short answers)
  correctAnswer: { type: Mixed, required: true },
  explanation: { type: String, required: true, trim: true, maxlength: 5000 },
  points: { type: Number, default: 1, min: 1, max: 100 },
});

const quizSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: 'User', required: true },
    topic: { type: ObjectId, ref: 'Topic', required: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 2000, default: '' },
    questions: { type: [questionSchema], default: [] },
    timeLimitMinutes: { type: Number, min: 1, max: 600, default: null },
  },
  { timestamps: true, toJSON },
);

quizSchema.index({ user: 1, topic: 1, createdAt: -1 });

/* -------------------------------- Attempt ------------------------------ */

const attemptAnswerSchema = new mongoose.Schema(
  {
    questionId: { type: ObjectId, required: true },
    // null = the question was left unanswered.
    answer: { type: String, default: null },
    isCorrect: { type: Boolean, required: true },
    pointsEarned: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const attemptSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: 'User', required: true },
    quiz: { type: ObjectId, ref: 'Quiz', required: true },
    topic: { type: ObjectId, ref: 'Topic', required: true },
    answers: { type: [attemptAnswerSchema], default: [] },
    score: { type: Number, required: true, min: 0 },
    maxScore: { type: Number, required: true, min: 0 },
    percentage: { type: Number, required: true, min: 0, max: 100 },
    durationSeconds: { type: Number, min: 0, default: 0 },
  },
  // Attempts are immutable, so there is no updatedAt.
  { timestamps: { createdAt: true, updatedAt: false }, toJSON },
);

attemptSchema.index({ user: 1, quiz: 1, createdAt: -1 });
// Progress: quiz score history, the summary average and the weekly report all read a user's
// attempts by date range, across every quiz (the index above needs a quiz id).
attemptSchema.index({ user: 1, createdAt: -1 });
// Progress: the same score history narrowed to one topic (?topic=), also used to group
// attempts per topic for subject progress and low-score weak topics.
attemptSchema.index({ user: 1, topic: 1, createdAt: -1 });

/* ------------------------------- Flashcard ----------------------------- */

const flashcardSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: 'User', required: true },
    topic: { type: ObjectId, ref: 'Topic', required: true },
    front: { type: String, required: true, trim: true, maxlength: 2000 },
    back: { type: String, required: true, trim: true, maxlength: 2000 },
    easeFactor: { type: Number, default: DEFAULT_EASE_FACTOR, min: 1.3 },
    intervalDays: { type: Number, default: 0, min: 0 },
    repetitions: { type: Number, default: 0, min: 0 },
    nextReview: { type: Date, default: () => new Date() },
    lastReviewedAt: { type: Date, default: null },
  },
  { timestamps: true, toJSON },
);

flashcardSchema.index({ user: 1, nextReview: 1 });
flashcardSchema.index({ user: 1, topic: 1, createdAt: -1 });

export const Quiz = mongoose.models.Quiz || mongoose.model('Quiz', quizSchema);
export const Attempt = mongoose.models.Attempt || mongoose.model('Attempt', attemptSchema);
export const Flashcard = mongoose.models.Flashcard || mongoose.model('Flashcard', flashcardSchema);
