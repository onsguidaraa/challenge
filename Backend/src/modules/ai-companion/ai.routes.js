import { Router } from 'express';
import { auth } from '../../middleware/auth.js';
import { sendSuccess } from '../../utils/response.js';
import { getStatus } from '../../services/ai.service.js';

const router = Router();
router.get('/status', auth, (_req, res) => sendSuccess(res, getStatus(), 'AI status'));
router.post('/chat', auth, (_req, res) => sendSuccess(res, getStatus(), 'AI chat is not implemented'));
export default router;
