import { Router } from 'express';
import authRoutes from '../modules/auth/auth.routes.js';
import onboardingRoutes from '../modules/onboarding/onboarding.routes.js';
import profileRoutes from '../modules/profile/profile.routes.js';
import spaceRoutes from '../modules/space/space.routes.js';
import lessonsRoutes from '../modules/lessons/lessons.routes.js';
import practiceRoutes from '../modules/practice/practice.routes.js';
import mistakesRoutes from '../modules/mistakes/mistakes.routes.js';
import plannerRoutes from '../modules/planner/planner.routes.js';
import progressRoutes from '../modules/progress/progress.routes.js';
import aiRoutes from '../modules/ai-companion/ai.routes.js';
import { sendSuccess } from '../utils/response.js';
import { authLimiter } from '../middleware/rateLimiters.js';

const router = Router();

router.get('/health', (_req, res) => {
  sendSuccess(res, { status: 'ok', uptime: process.uptime() }, 'Service is healthy');
});

router.use('/auth', authLimiter, authRoutes);
router.use('/onboarding', onboardingRoutes);
router.use('/profile', profileRoutes);
// Lessons first: they live under /topics/:topicId/lesson and authenticate per route.
router.use('/topics', lessonsRoutes);
// Quizzes, attempts and flashcards (nested under /topics/:topicId/... and standalone).
router.use(practiceRoutes);
router.use('/mistakes', mistakesRoutes);
router.use(spaceRoutes);
// Study plans, tasks, study sessions and suggestions (/plans, /tasks, /sessions, /planner).
router.use(plannerRoutes);
// "My Growth" reports (summary, subjects, quizzes, activity, heatmap, weekly report).
router.use('/progress', progressRoutes);
router.use('/ai', aiRoutes);

// Future modules (extension points, no logic yet): ai-companion, material-reader,
// listen-learn, gamification, adaptive-learning, study-together.

export default router;
