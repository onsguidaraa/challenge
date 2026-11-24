import { z } from 'zod';
import { objectId } from '../../utils/objectId.js';
import { paginationQuery } from '../../utils/pagination.js';
import { REVIEW_RATINGS } from '../../utils/spacedRepetition.js';

export { idParamSchema, topicIdParamSchema } from '../space/space.validation.js';

const requiredText = (max, label) => z.string().trim().min(1, `${label} is required`).max(max);

const atLeastOneField = [
  (body) => Object.keys(body).length > 0,
  'Provide at least one field to update',
];

/* -------------------------------- Questions ---------------------------- */

/** true/false values are stored as the strings "true" / "false". */
const trueFalseValue = z
  .union([
    z.boolean(),
    z
      .string()
      .trim()
      .toLowerCase()
      .pipe(z.enum(['true', 'false'])),
  ])
  .transform((value) => String(value));

const acceptedAnswers = z.union([
  requiredText(500, 'Correct answer'),
  z
    .array(requiredText(500, 'Accepted answer'))
    .min(1, 'Provide at least one accepted answer')
    .max(20, 'At most 20 accepted answers')
    .transform((items) => [...new Set(items)]),
]);

/**
 * Each question type has its own rules; fields of other types are stripped.
 * `withId` allows an existing question id (PATCH) so edits keep the question's
 * identity, and with it the Mistake Notebook entries that point at it.
 */
const buildQuestionSchema = ({ withId }) => {
  const common = {
    ...(withId ? { id: objectId.optional() } : {}),
    prompt: requiredText(2000, 'Prompt'),
    explanation: requiredText(5000, 'Explanation'),
    points: z.number().int().min(1).max(100).default(1),
  };

  const mcq = z
    .object({
      ...common,
      type: z.literal('mcq'),
      options: z
        .array(requiredText(500, 'Option'))
        .min(2, 'A multiple choice question needs at least 2 options')
        .max(10, 'At most 10 options'),
      correctAnswer: requiredText(500, 'Correct answer'),
    })
    .superRefine((question, ctx) => {
      if (new Set(question.options).size !== question.options.length) {
        ctx.addIssue({ code: 'custom', path: ['options'], message: 'Options must be unique' });
      }
      if (!question.options.includes(question.correctAnswer)) {
        ctx.addIssue({
          code: 'custom',
          path: ['correctAnswer'],
          message: 'The correct answer must match one of the options',
        });
      }
    });

  const trueFalse = z.object({
    ...common,
    type: z.literal('true_false'),
    correctAnswer: trueFalseValue,
  });

  const shortAnswer = z.object({
    ...common,
    type: z.literal('short_answer'),
    correctAnswer: acceptedAnswers,
  });

  return z.discriminatedUnion('type', [mcq, trueFalse, shortAnswer]);
};

export const questionSchema = buildQuestionSchema({ withId: false });
const questionUpdateSchema = buildQuestionSchema({ withId: true });

/* ---------------------------------- Quiz ------------------------------- */

const quizFields = {
  title: requiredText(200, 'Title'),
  description: z.string().trim().max(2000),
  timeLimitMinutes: z.number().int().min(1).max(600).nullable(),
};

const questionList = (schema) =>
  z.array(schema).min(1, 'A quiz needs at least one question').max(100, 'At most 100 questions');

export const createQuizSchema = z.object({
  title: quizFields.title,
  description: quizFields.description.optional(),
  timeLimitMinutes: quizFields.timeLimitMinutes.optional(),
  questions: questionList(questionSchema),
});

/** PATCH. `questions` replaces the list; send `id` on questions that should be kept. */
export const updateQuizSchema = z
  .object({ ...quizFields, questions: questionList(questionUpdateSchema) })
  .partial()
  .refine(...atLeastOneField);

export const listQuizzesQuerySchema = z.object({ ...paginationQuery });

/* --------------------------------- Submit ------------------------------ */

const submittedAnswer = z
  .union([z.string().max(2000), z.boolean()])
  .transform((value) => (typeof value === 'boolean' ? String(value) : value));

export const submitQuizSchema = z.object({
  answers: z
    .array(z.object({ questionId: objectId, answer: submittedAnswer }))
    .min(1, 'Provide at least one answer')
    .max(100)
    .refine(
      (items) => new Set(items.map((a) => a.questionId.toLowerCase())).size === items.length,
      {
        message: 'Each question can only be answered once',
      },
    ),
  durationSeconds: z.number().int().min(0).max(86400).default(0),
});

export const listAttemptsQuerySchema = z.object({ ...paginationQuery });

/* ------------------------------- Flashcards ---------------------------- */

const flashcardFields = {
  front: requiredText(2000, 'Front'),
  back: requiredText(2000, 'Back'),
};

export const createFlashcardSchema = z.object(flashcardFields);

export const bulkFlashcardsSchema = z.object({
  cards: z
    .array(createFlashcardSchema)
    .min(1, 'Provide at least one card')
    .max(100, 'At most 100 cards per request'),
});

export const updateFlashcardSchema = z
  .object(flashcardFields)
  .partial()
  .refine(...atLeastOneField);

export const listFlashcardsQuerySchema = z.object({ ...paginationQuery });

export const dueFlashcardsQuerySchema = z.object({
  ...paginationQuery,
  topic: objectId.optional(),
});

export const flashcardStatsQuerySchema = z.object({ topic: objectId.optional() });

export const reviewFlashcardSchema = z.object({ rating: z.enum(REVIEW_RATINGS) });
