import mongoose from 'mongoose';

export const LESSON_FORMATS = ['simplified', 'diagram', 'steps', 'examples'];
export const DIAGRAM_TYPES = ['mermaid', 'svg'];

const { ObjectId } = mongoose.Schema.Types;

const diagramSchema = new mongoose.Schema(
  {
    type: { type: String, enum: DIAGRAM_TYPES, required: true },
    source: { type: String, required: true, maxlength: 50000 },
  },
  { _id: false },
);

const stepSchema = new mongoose.Schema(
  {
    order: { type: Number, required: true, min: 1 },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    content: { type: String, required: true, maxlength: 5000 },
  },
  { _id: false },
);

const exampleSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    content: { type: String, required: true, maxlength: 5000 },
  },
  { _id: false },
);

const lessonSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: 'User', required: true },
    // One lesson per topic.
    topic: { type: ObjectId, ref: 'Topic', required: true, unique: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    formats: {
      simplified: { type: String, maxlength: 20000, default: '' },
      diagram: { type: diagramSchema, default: undefined },
      steps: { type: [stepSchema], default: [] },
      examples: { type: [exampleSchema], default: [] },
    },
    // Quiz ids. Only writable through PATCH, which verifies the user owns every quiz.
    exercises: { type: [{ type: ObjectId, ref: 'Quiz' }], default: [] },
    completed: { type: Boolean, default: false },
    completedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (doc, ret) => {
        // Also runs for sub-documents, which have no _id here.
        if (ret._id) {
          ret.id = String(ret._id);
          delete ret._id;
        }
        delete ret.__v;
        return ret;
      },
    },
  },
);

// Progress: lessons completed vs total, and lessons completed per week, are counted by
// user + completed (+ completedAt). Lesson only has a unique index on topic otherwise.
lessonSchema.index({ user: 1, completed: 1, completedAt: -1 });

export const Lesson = mongoose.models.Lesson || mongoose.model('Lesson', lessonSchema);
