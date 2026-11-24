import { Router } from 'express';
import * as controller from './profile.controller.js';
import { validate } from '../../middleware/validate.js';
import { auth } from '../../middleware/auth.js';
import { updateProfileSchema } from './profile.validation.js';

const router = Router();

router.use(auth);

router.get('/', controller.getProfile);
router.patch('/', validate({ body: updateProfileSchema }), controller.updateProfile);
router.get('/summary', controller.getSummary);
router.post('/recompute', controller.recompute);

export default router;
