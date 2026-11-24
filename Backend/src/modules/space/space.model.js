import mongoose from 'mongoose';

export const TOPIC_STATUSES = ['not_started', 'in_progress', 'completed'];
export const TOPIC_DIFFICULTIES = ['easy', 'medium', 'hard'];
export const MATERIAL_TYPES = ['note', 'link', 'file'];

const { ObjectId } = mongoose.Schema.Types;

const toJSON = {
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    return ret;
  },
};

/* ------------------------------- Subject ------------------------------- */

const subjectSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    description: { type: String, trim: true, maxlength: 1000, default: '' },
    color: { type: String, match: /^#[0-9a-fA-F]{6}$/, default: null },
    icon: { type: String, trim: true, maxlength: 50, default: null },
    archived: { type: Boolean, default: false },
  },
  { timestamps: true, toJSON },
);

// Case-insensitive: "Math" and "math" are the same subject for one user.
subjectSchema.index(
  { user: 1, name: 1 },
  { unique: true, collation: { locale: 'en', strength: 2 } },
);
subjectSchema.index({ user: 1, archived: 1, createdAt: -1 });

/* -------------------------------- Topic -------------------------------- */

const topicSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: 'User', required: true },
    subject: { type: ObjectId, ref: 'Subject', required: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 2000, default: '' },
    order: { type: Number, required: true, min: 0, default: 0 },
    status: { type: String, enum: TOPIC_STATUSES, default: 'not_started' },
    difficulty: { type: String, enum: TOPIC_DIFFICULTIES, default: 'medium' },
  },
  { timestamps: true, toJSON },
);

topicSchema.index({ subject: 1, order: 1 });
topicSchema.index({ user: 1, subject: 1 });
// Progress: topics completed vs total, overall and per subject, are grouped by status.
topicSchema.index({ user: 1, subject: 1, status: 1 });

/* ------------------------------- Material ------------------------------ */

const materialSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: 'User', required: true },
    topic: { type: ObjectId, ref: 'Topic', required: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    type: { type: String, enum: MATERIAL_TYPES, required: true },
    // Per-type fields. Zod enforces the exact rules; these are a second line of defense.
    content: {
      type: String,
      maxlength: 50000,
      required: function requiredForNote() {
        return this.type === 'note';
      },
    },
    url: {
      type: String,
      maxlength: 2048,
      required: function requiredForLink() {
        return this.type === 'link';
      },
    },
    // Schema only for now: real uploads are not implemented yet.
    fileUrl: {
      type: String,
      maxlength: 2048,
      required: function requiredForFile() {
        return this.type === 'file';
      },
    },
    mimeType: {
      type: String,
      maxlength: 127,
      required: function requiredForFileMime() {
        return this.type === 'file';
      },
    },
    tags: { type: [String], default: [] },
  },
  { timestamps: true, toJSON },
);

materialSchema.index({ topic: 1, createdAt: -1 });

export const Subject = mongoose.models.Subject || mongoose.model('Subject', subjectSchema);
export const Topic = mongoose.models.Topic || mongoose.model('Topic', topicSchema);
export const Material = mongoose.models.Material || mongoose.model('Material', materialSchema);
