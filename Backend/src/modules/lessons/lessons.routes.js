import { Router } from 'express';
import * as controller from './lessons.controller.js';
import { validate } from '../../middleware/validate.js';
import { auth } from '../../middleware/auth.js';
import {
  topicIdParamSchema,
  putLessonSchema,
  patchLessonSchema,
  getLessonQuerySchema,
} from './lessons.validation.js';

/**
 * Mounted at /topics. `auth` is applied per route (not router.use) so requests
 * for other /topics/* routes handled by the space router are not authenticated twice.
 */
const router = Router();
const params = { params: topicIdParamSchema };

router.get('/:topicId/lesson/formats', auth, validate(params), controller.getFormats);
router.post('/:topicId/lesson/complete', auth, validate(params), controller.completeLesson);

router.get(
  '/:topicId/lesson',
  auth,
  validate({ ...params, query: getLessonQuerySchema }),
  controller.getLesson,
);
router.put(
  '/:topicId/lesson',
  auth,
  validate({ ...params, body: putLessonSchema }),
  controller.putLesson,
);
router.patch(
  '/:topicId/lesson',
  auth,
  validate({ ...params, body: patchLessonSchema }),
  controller.patchLesson,
);
router.delete('/:topicId/lesson', auth, validate(params), controller.deleteLesson);

export default router;
