import mongoose from 'mongoose';

export const ACTIVITY_TYPES = [
  'lesson_opened',
  'lesson_completed',
  'quiz_submitted',
  'flashcard_reviewed',
  'session_started',
  'session_finished',
  'task_completed',
  'onboarding_completed',
];

const activityLogSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: ACTIVITY_TYPES, required: true },
    // Optional pointer to the thing the event is about (lesson, quiz, session, ...).
    refId: { type: mongoose.Schema.Types.ObjectId, default: null },
    refModel: { type: String, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  {
    // Events are immutable, so there is no updatedAt.
    timestamps: { createdAt: true, updatedAt: false },
    toJSON: {
      transform: (_doc, ret) => {
        ret.id = String(ret._id);
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  },
);

activityLogSchema.index({ user: 1, createdAt: 1 });
activityLogSchema.index({ user: 1, type: 1 });
// Progress: the activity timeline, the heatmap and per-type counts (flashcards reviewed, ...)
// filter by user + date range and optionally by type, newest first. Without it the
// date range would be scanned through the {user, type} index or sorted in memory.
activityLogSchema.index({ user: 1, type: 1, createdAt: -1 });

export const ActivityLog =
  mongoose.models.ActivityLog || mongoose.model('ActivityLog', activityLogSchema);
