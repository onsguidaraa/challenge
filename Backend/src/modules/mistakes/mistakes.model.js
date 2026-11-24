import mongoose from 'mongoose';

const { ObjectId, Mixed } = mongoose.Schema.Types;

/** Consecutive correct answers needed to resolve a mistake automatically. */
export const RESOLVE_STREAK = 2;

const mistakeSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: 'User', required: true },
    topic: { type: ObjectId, ref: 'Topic', required: true },
    quiz: { type: ObjectId, ref: 'Quiz', required: true },
    questionId: { type: ObjectId, required: true },
    // Snapshot taken at the time of the (last) wrong answer.
    questionPrompt: { type: String, required: true },
    userAnswer: { type: String, default: null },
    correctAnswer: { type: Mixed, required: true },
    explanation: { type: String, required: true },
    retryCount: { type: Number, default: 0, min: 0 },
    correctStreak: { type: Number, default: 0, min: 0 },
    resolved: { type: Boolean, default: false },
    resolvedAt: { type: Date, default: null },
    lastAttemptedAt: { type: Date, default: () => new Date() },
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

// The same wrong question is updated, never duplicated.
mistakeSchema.index({ user: 1, quiz: 1, questionId: 1 }, { unique: true });
mistakeSchema.index({ user: 1, resolved: 1, topic: 1 });

/**
 * Topics ranked by their number of unresolved mistakes (most first; ties go to the
 * most recent mistake, then the id so the order is stable). Shared by the weak-topics
 * endpoint and profile.service#recomputeLearnedStats.
 * @returns {Promise<{ rows: { topicId, unresolvedCount, lastMistakeAt }[], total: number }>}
 */
mistakeSchema.statics.rankWeakTopics = async function rankWeakTopics(
  userId,
  { skip = 0, limit = 10 } = {},
) {
  const user = new mongoose.Types.ObjectId(String(userId));
  const [result] = await this.aggregate([
    { $match: { user, resolved: false } },
    {
      $group: {
        _id: '$topic',
        unresolvedCount: { $sum: 1 },
        lastMistakeAt: { $max: '$lastAttemptedAt' },
      },
    },
    { $sort: { unresolvedCount: -1, lastMistakeAt: -1, _id: 1 } },
    {
      $facet: {
        rows: [{ $skip: skip }, { $limit: limit }],
        total: [{ $count: 'count' }],
      },
    },
  ]);

  return {
    rows: result.rows.map(({ _id, unresolvedCount, lastMistakeAt }) => ({
      topicId: _id,
      unresolvedCount,
      lastMistakeAt,
    })),
    total: result.total[0]?.count ?? 0,
  };
};

export const Mistake = mongoose.models.Mistake || mongoose.model('Mistake', mistakeSchema);
