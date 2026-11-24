import { Router } from 'express';
import * as controller from './onboarding.controller.js';
import { validate } from '../../middleware/validate.js';
import { auth } from '../../middleware/auth.js';
import { onboardingSchema } from './onboarding.validation.js';

const router = Router();

router.use(auth);

router.post('/', validate({ body: onboardingSchema }), controller.submit);
router.get('/status', controller.status);

export default router;
