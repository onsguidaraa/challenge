import { Router } from 'express';
import * as controller from './progress.controller.js';
import { validate } from '../../middleware/validate.js';
import { auth } from '../../middleware/auth.js';
import {
  subjectIdParamSchema,
  subjectsQuerySchema,
  quizHistoryQuerySchema,
  activityQuerySchema,
  heatmapQuerySchema,
} from './progress.validation.js';

/** Mounted at /progress ("My Growth"). Read-only: nothing here writes data. */
const router = Router();

router.use(auth);

router.get('/summary', controller.getSummary);
router.get('/subjects', validate({ query: subjectsQuerySchema }), controller.getSubjects);
router.get('/subjects/:id', validate({ params: subjectIdParamSchema }), controller.getSubject);
router.get('/quizzes', validate({ query: quizHistoryQuerySchema }), controller.getQuizzes);
router.get('/activity', validate({ query: activityQuerySchema }), controller.getActivity);
router.get('/heatmap', validate({ query: heatmapQuerySchema }), controller.getHeatmap);
router.get('/weekly-report', controller.getWeeklyReport);

export default router;
