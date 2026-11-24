import { Router } from 'express';
import * as controller from './auth.controller.js';
import { validate } from '../../middleware/validate.js';
import { auth } from '../../middleware/auth.js';
import { registerSchema, loginSchema, refreshSchema, logoutSchema } from './auth.validation.js';

const router = Router();

router.post('/register', validate({ body: registerSchema }), controller.register);
router.post('/login', validate({ body: loginSchema }), controller.login);
router.post('/refresh', validate({ body: refreshSchema }), controller.refresh);
router.post('/logout', validate({ body: logoutSchema }), controller.logout);
router.get('/me', auth, controller.me);
router.delete('/me', auth, controller.deleteMe);

export default router;
