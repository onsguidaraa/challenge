import { Router } from 'express';
import * as controller from './planner.controller.js';
import { validate } from '../../middleware/validate.js';
import { auth } from '../../middleware/auth.js';
import {
  idParamSchema,
  planIdParamSchema,
  createPlanSchema,
  updatePlanSchema,
  listPlansQuerySchema,
  createTaskSchema,
  updateTaskSchema,
  listTasksQuerySchema,
  upcomingQuerySchema,
  startSessionSchema,
  stopSessionSchema,
  listSessionsQuerySchema,
  sessionStatsQuerySchema,
  suggestionsQuerySchema,
} from './planner.validation.js';

/**
 * Mounted at the API root (/plans, /tasks, /sessions, /planner). `auth` is applied per
 * path prefix so unrelated requests passing through this router are not authenticated here.
 */
const router = Router();

router.use(['/plans', '/tasks', '/sessions', '/planner'], auth);

/* --------------------------------- Plans ------------------------------- */

router
  .route('/plans')
  .post(validate({ body: createPlanSchema }), controller.createPlan)
  .get(validate({ query: listPlansQuerySchema }), controller.listPlans);

router
  .route('/plans/:id')
  .get(validate({ params: idParamSchema }), controller.getPlan)
  .patch(validate({ params: idParamSchema, body: updatePlanSchema }), controller.updatePlan)
  .delete(validate({ params: idParamSchema }), controller.deletePlan);

router
  .route('/plans/:planId/tasks')
  .post(validate({ params: planIdParamSchema, body: createTaskSchema }), controller.createPlanTask)
  .get(
    validate({ params: planIdParamSchema, query: listTasksQuerySchema }),
    controller.listPlanTasks,
  );

/* --------------------------------- Tasks ------------------------------- */

router
  .route('/tasks')
  .post(validate({ body: createTaskSchema }), controller.createTask)
  .get(validate({ query: listTasksQuerySchema }), controller.listTasks);

// Static path first so it is not captured by /tasks/:id.
router.get(
  '/tasks/upcoming',
  validate({ query: upcomingQuerySchema }),
  controller.getUpcomingTasks,
);

router
  .route('/tasks/:id')
  .get(validate({ params: idParamSchema }), controller.getTask)
  .patch(validate({ params: idParamSchema, body: updateTaskSchema }), controller.updateTask)
  .delete(validate({ params: idParamSchema }), controller.deleteTask);

router.patch('/tasks/:id/complete', validate({ params: idParamSchema }), controller.completeTask);
router.patch('/tasks/:id/reopen', validate({ params: idParamSchema }), controller.reopenTask);

/* ------------------------------- Sessions ------------------------------ */

router.post('/sessions/start', validate({ body: startSessionSchema }), controller.startSession);
router.get('/sessions/active', controller.getActiveSession);
router.get(
  '/sessions/stats',
  validate({ query: sessionStatsQuerySchema }),
  controller.getSessionStats,
);
router.get('/sessions', validate({ query: listSessionsQuerySchema }), controller.listSessions);
router.post(
  '/sessions/:id/stop',
  validate({ params: idParamSchema, body: stopSessionSchema }),
  controller.stopSession,
);

/* ------------------------------ Suggestions ---------------------------- */

router.get(
  '/planner/suggestions',
  validate({ query: suggestionsQuerySchema }),
  controller.getSuggestions,
);

export default router;
