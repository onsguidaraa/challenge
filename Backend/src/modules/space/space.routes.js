import { Router } from 'express';
import * as controller from './space.controller.js';
import { validate } from '../../middleware/validate.js';
import { auth } from '../../middleware/auth.js';
import {
  idParamSchema,
  subjectIdParamSchema,
  topicIdParamSchema,
  createSubjectSchema,
  updateSubjectSchema,
  listSubjectsQuerySchema,
  createTopicSchema,
  updateTopicSchema,
  listTopicsQuerySchema,
  reorderTopicsSchema,
  createMaterialSchema,
  updateMaterialSchema,
  listMaterialsQuerySchema,
} from './space.validation.js';

/**
 * Mounted at the API root because the resources are nested
 * (/subjects/:subjectId/topics, /topics/:topicId/materials, ...).
 */
const router = Router();

router.use(['/subjects', '/topics', '/materials'], auth);

/* ------------------------------- Subjects ------------------------------ */

router
  .route('/subjects')
  .post(validate({ body: createSubjectSchema }), controller.createSubject)
  .get(validate({ query: listSubjectsQuerySchema }), controller.listSubjects);

router
  .route('/subjects/:id')
  .get(validate({ params: idParamSchema }), controller.getSubject)
  .patch(validate({ params: idParamSchema, body: updateSubjectSchema }), controller.updateSubject)
  .delete(validate({ params: idParamSchema }), controller.deleteSubject);

/* -------------------------------- Topics ------------------------------- */

router
  .route('/subjects/:subjectId/topics')
  .post(validate({ params: subjectIdParamSchema, body: createTopicSchema }), controller.createTopic)
  .get(
    validate({ params: subjectIdParamSchema, query: listTopicsQuerySchema }),
    controller.listTopics,
  );

router.patch(
  '/subjects/:subjectId/topics/reorder',
  validate({ params: subjectIdParamSchema, body: reorderTopicsSchema }),
  controller.reorderTopics,
);

router
  .route('/topics/:id')
  .get(validate({ params: idParamSchema }), controller.getTopic)
  .patch(validate({ params: idParamSchema, body: updateTopicSchema }), controller.updateTopic)
  .delete(validate({ params: idParamSchema }), controller.deleteTopic);

/* ------------------------------- Materials ----------------------------- */

router
  .route('/topics/:topicId/materials')
  .post(
    validate({ params: topicIdParamSchema, body: createMaterialSchema }),
    controller.createMaterial,
  )
  .get(
    validate({ params: topicIdParamSchema, query: listMaterialsQuerySchema }),
    controller.listMaterials,
  );

router
  .route('/materials/:id')
  .get(validate({ params: idParamSchema }), controller.getMaterial)
  .patch(validate({ params: idParamSchema, body: updateMaterialSchema }), controller.updateMaterial)
  .delete(validate({ params: idParamSchema }), controller.deleteMaterial);

export default router;
