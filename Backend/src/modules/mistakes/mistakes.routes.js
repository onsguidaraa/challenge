import { Router } from 'express';
import * as controller from './mistakes.controller.js';
import { validate } from '../../middleware/validate.js';
import { auth } from '../../middleware/auth.js';
import {
  idParamSchema,
  listMistakesQuerySchema,
  weakTopicsQuerySchema,
  practiceMistakesSchema,
} from './mistakes.validation.js';

/** Mounted at /mistakes. */
const router = Router();

router.use(auth);

router.get('/', validate({ query: listMistakesQuerySchema }), controller.listMistakes);

// Static paths first so they are not captured by /:id.
router.get('/weak-topics', validate({ query: weakTopicsQuerySchema }), controller.getWeakTopics);
router.post('/practice', validate({ body: practiceMistakesSchema }), controller.practiceMistakes);

router.get('/:id', validate({ params: idParamSchema }), controller.getMistake);
router.patch('/:id/resolve', validate({ params: idParamSchema }), controller.resolveMistake);
router.patch('/:id/unresolve', validate({ params: idParamSchema }), controller.unresolveMistake);

export default router;
