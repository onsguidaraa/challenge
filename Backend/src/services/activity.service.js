import { ActivityLog } from '../modules/activity-log/activity-log.model.js';
import { STREAK_ACTIVITY_TYPES, updateStreak } from '../modules/progress/streak.service.js';
import { logger } from '../utils/logger.js';

/**
 * Records an activity event for a user. Qualifying events (lesson completed, quiz
 * submitted, flashcard reviewed, session finished) also update the user's streak.
 *
 * Logging is a side effect of other features, so this function NEVER throws:
 * any failure (validation, DB down, streak update, ...) is logged and swallowed.
 *
 * @returns the saved event, or null if it could not be saved
 */
export const logActivity = async ({ user, type, refId, refModel, metadata } = {}) => {
  let event;
  try {
    event = await ActivityLog.create({
      user,
      type,
      refId: refId ?? null,
      refModel: refModel ?? null,
      metadata: metadata ?? {},
    });
  } catch (err) {
    logger.error('Failed to log activity', { type, user: String(user), error: err?.message });
    return null;
  }

  if (STREAK_ACTIVITY_TYPES.includes(type)) {
    try {
      await updateStreak(user, { now: event.createdAt });
    } catch (err) {
      logger.error('Failed to update streak', { type, user: String(user), error: err?.message });
    }
  }

  return event;
};
