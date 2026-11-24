import mongoose from 'mongoose';

export const ACADEMIC_LEVELS = [
  'middle_school',
  'high_school',
  'undergraduate',
  'graduate',
  'professional',
  'other',
];
export const PREFERRED_FORMATS = ['simplified', 'visual', 'step_by_step', 'examples', 'practice'];
export const TIMES_OF_DAY = ['morning', 'afternoon', 'evening', 'night'];
/** Lesson formats tracked in learnedStats.formatUsage (same keys as the Lesson model). */
export const LEARNED_FORMATS = ['simplified', 'diagram', 'steps', 'examples'];

const counter = { type: Number, default: 0, min: 0 };

const profileSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
    academicLevel: { type: String, enum: ACADEMIC_LEVELS, required: true },
    interests: { type: [String], default: [] },
    goals: { type: [String], default: [] },
    difficulties: { type: [String], default: [] },
    preferredFormats: {
      type: [{ type: String, enum: PREFERRED_FORMATS }],
      default: [],
    },
    // IANA timezone ("Europe/Paris"). Day boundaries for streaks and reports; UTC when null.
    timezone: { type: String, default: null },
    studyHabits: {
      bestTimeOfDay: { type: String, enum: TIMES_OF_DAY, default: null },
      preferredSessionMinutes: { type: Number, min: 1, default: null },
      sessionsPerWeek: { type: Number, min: 0, default: null },
    },
    // Computed by profile.service#recomputeLearnedStats. Never user-editable.
    learnedStats: {
      formatUsage: {
        simplified: counter,
        diagram: counter,
        steps: counter,
        examples: counter,
      },
      avgSessionMinutes: { type: Number, default: null, min: 0 },
      weakTopics: { type: [mongoose.Schema.Types.ObjectId], default: [] },
      // Hour of day (0-23) in the user's timezone (UTC when none is set).
      mostActiveHour: { type: Number, default: null, min: 0, max: 23 },
      // Most opened lesson format, derived from formatUsage. Null until a lesson is opened.
      dominantFormat: { type: String, enum: [...LEARNED_FORMATS, null], default: null },
      // Part of the day derived from mostActiveHour.
      recommendedBestTime: { type: String, enum: [...TIMES_OF_DAY, null], default: null },
      lastComputedAt: { type: Date, default: null },
    },
  },
  {
    timestamps: true,
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

export const Profile = mongoose.models.Profile || mongoose.model('Profile', profileSchema);
