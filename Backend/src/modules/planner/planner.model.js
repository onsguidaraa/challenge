import mongoose from 'mongoose';

export const PLAN_STATUSES = ['active', 'completed', 'paused', 'archived'];
export const TASK_TYPES = ['study', 'revise', 'practice', 'quiz', 'other'];
export const TASK_PRIORITIES = ['low', 'medium', 'high'];
export const TASK_STATUSES = ['todo', 'in_progress', 'done', 'skipped'];
export const RECURRENCE_TYPES = ['none', 'daily', 'weekly'];
export const SESSION_STATUSES = ['active', 'completed', 'abandoned'];

const { ObjectId } = mongoose.Schema.Types;

const toJSON = {
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    return ret;
  },
};

/* ------------------------------- StudyPlan ----------------------------- */

const studyPlanSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: 'User', required: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 2000, default: '' },
    goal: { type: String, trim: true, maxlength: 2000, default: '' },
    targetDate: { type: Date, default: null },
    startDate: { type: Date, default: () => new Date() },
    subjects: { type: [{ type: ObjectId, ref: 'Subject' }], default: [] },
    status: { type: String, enum: PLAN_STATUSES, default: 'active' },
    // Computed by planner.service#recomputePlanProgress (percentage 0-100). Never user-editable.
    progress: { type: Number, default: 0, min: 0, max: 100 },
  },
  { timestamps: true, toJSON },
);

studyPlanSchema.index({ user: 1, status: 1, createdAt: -1 });

/* --------------------------------- Task -------------------------------- */

const taskSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: 'User', required: true },
    plan: { type: ObjectId, ref: 'StudyPlan', default: null },
    subject: { type: ObjectId, ref: 'Subject', default: null },
    topic: { type: ObjectId, ref: 'Topic', default: null },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    notes: { type: String, trim: true, maxlength: 5000, default: '' },
    type: { type: String, enum: TASK_TYPES, default: 'study' },
    dueDate: { type: Date, default: null },
    estimatedMinutes: { type: Number, min: 1, max: 1440, default: null },
    priority: { type: String, enum: TASK_PRIORITIES, default: 'medium' },
    status: { type: String, enum: TASK_STATUSES, default: 'todo' },
    completedAt: { type: Date, default: null },
    recurrence: {
      type: { type: String, enum: RECURRENCE_TYPES, default: 'none' },
      until: { type: Date, default: null },
    },
    // Set when completing a recurring task spawned its next occurrence, so completing the
    // task again after a reopen never creates a duplicate.
    nextOccurrence: { type: ObjectId, ref: 'Task', default: null },
  },
  { timestamps: true, toJSON },
);

taskSchema.index({ user: 1, plan: 1, dueDate: 1 });
taskSchema.index({ user: 1, status: 1, dueDate: 1 });
taskSchema.index({ user: 1, topic: 1 });
// Progress: "tasks completed this week" counts done tasks by completion date; the
// {user, status, dueDate} index above is ordered by due date, not completion date.
taskSchema.index({ user: 1, status: 1, completedAt: -1 });

/* ------------------------------ StudySession --------------------------- */

const studySessionSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: 'User', required: true },
    task: { type: ObjectId, ref: 'Task', default: null },
    topic: { type: ObjectId, ref: 'Topic', default: null },
    plannedMinutes: { type: Number, min: 1, max: 720, default: null },
    startedAt: { type: Date, required: true, default: () => new Date() },
    endedAt: { type: Date, default: null },
    // Computed when the session is stopped. 0 for abandoned sessions (no reliable end time).
    durationMinutes: { type: Number, min: 0, default: null },
    status: { type: String, enum: SESSION_STATUSES, default: 'active' },
    notes: { type: String, trim: true, maxlength: 5000, default: '' },
    focusRating: { type: Number, min: 1, max: 5, default: null },
  },
  { timestamps: true, toJSON },
);

studySessionSchema.index({ user: 1, startedAt: -1 });
studySessionSchema.index({ user: 1, topic: 1, startedAt: -1 });
// Progress: study minutes (this week / all time / per topic) sum durationMinutes of completed
// sessions. Including durationMinutes lets the aggregation be answered from the index alone.
studySessionSchema.index({ user: 1, status: 1, startedAt: -1, durationMinutes: 1 });
// At most one active session per user, enforced by the database (races included).
studySessionSchema.index(
  { user: 1 },
  { unique: true, partialFilterExpression: { status: 'active' }, name: 'one_active_session' },
);

export const StudyPlan = mongoose.models.StudyPlan || mongoose.model('StudyPlan', studyPlanSchema);
export const Task = mongoose.models.Task || mongoose.model('Task', taskSchema);
export const StudySession =
  mongoose.models.StudySession || mongoose.model('StudySession', studySessionSchema);
