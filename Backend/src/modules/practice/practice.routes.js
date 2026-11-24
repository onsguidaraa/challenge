import { Router } from 'express';
import * as controller from './practice.controller.js';
import { validate } from '../../middleware/validate.js';
import { auth } from '../../middleware/auth.js';
import {
  idParamSchema,
  topicIdParamSchema,
  createQuizSchema,
  updateQuizSchema,
  listQuizzesQuerySchema,
  submitQuizSchema,
  listAttemptsQuerySchema,
  createFlashcardSchema,
  bulkFlashcardsSchema,
  updateFlashcardSchema,
  listFlashcardsQuerySchema,
  dueFlashcardsQuerySchema,
  flashcardStatsQuerySchema,
  reviewFlashcardSchema,
} from './practice.validation.js';

/**
 * Mounted at the API root (quizzes and flashcards are nested under /topics, attempts
 * stand alone). `auth` is applied per path prefix / route instead of router.use(auth),
 * so unrelated requests that pass through this router are not authenticated here.
 */
const router = Router();

router.use(['/quizzes', '/attempts', '/flashcards'], auth);

/* ---------------------------------- Quiz -------------------------------- */

router
  .route('/topics/:topicId/quizzes')
  .post(
    auth,
    validate({ params: topicIdParamSchema, body: createQuizSchema }),
    controller.createQuiz,
  )
  .get(
    auth,
    validate({ params: topicIdParamSchema, query: listQuizzesQuerySchema }),
    controller.listQuizzes,
  );

router.get('/quizzes/:id/edit', validate({ params: idParamSchema }), controller.getQuizForEditing);

router
  .route('/quizzes/:id')
  .get(validate({ params: idParamSchema }), controller.getQuiz)
  .patch(validate({ params: idParamSchema, body: updateQuizSchema }), controller.updateQuiz)
  .delete(validate({ params: idParamSchema }), controller.deleteQuiz);

/* ------------------------------ Submit / history ------------------------ */

router.post(
  '/quizzes/:id/submit',
  validate({ params: idParamSchema, body: submitQuizSchema }),
  controller.submitQuiz,
);
router.get(
  '/quizzes/:id/attempts',
  validate({ params: idParamSchema, query: listAttemptsQuerySchema }),
  controller.listAttempts,
);
router.get('/attempts/:id', validate({ params: idParamSchema }), controller.getAttempt);

/* ------------------------------- Flashcards ----------------------------- */

router.post(
  '/topics/:topicId/flashcards/bulk',
  auth,
  validate({ params: topicIdParamSchema, body: bulkFlashcardsSchema }),
  controller.bulkCreateFlashcards,
);

router
  .route('/topics/:topicId/flashcards')
  .post(
    auth,
    validate({ params: topicIdParamSchema, body: createFlashcardSchema }),
    controller.createFlashcard,
  )
  .get(
    auth,
    validate({ params: topicIdParamSchema, query: listFlashcardsQuerySchema }),
    controller.listFlashcards,
  );

// Static paths first so they are not captured by /flashcards/:id.
router.get(
  '/flashcards/due',
  validate({ query: dueFlashcardsQuerySchema }),
  controller.listDueFlashcards,
);
router.get(
  '/flashcards/stats',
  validate({ query: flashcardStatsQuerySchema }),
  controller.getFlashcardStats,
);

router
  .route('/flashcards/:id')
  .get(validate({ params: idParamSchema }), controller.getFlashcard)
  .patch(
    validate({ params: idParamSchema, body: updateFlashcardSchema }),
    controller.updateFlashcard,
  )
  .delete(validate({ params: idParamSchema }), controller.deleteFlashcard);

router.post(
  '/flashcards/:id/review',
  validate({ params: idParamSchema, body: reviewFlashcardSchema }),
  controller.reviewFlashcard,
);

export default router;
