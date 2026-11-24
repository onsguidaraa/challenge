import {
  scheduleReview,
  LAPSE_RELEARN_MINUTES,
  MIN_EASE_FACTOR,
} from '../src/utils/spacedRepetition.js';

const NOW = new Date('2025-03-01T12:00:00.000Z');
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

describe('scheduleReview (SM-2)', () => {
  // [description, card, rating, expected easeFactor, intervalDays, repetitions]
  const table = [
    ['new card, again', { easeFactor: 2.5, intervalDays: 0, repetitions: 0 }, 'again', 2.3, 0, 0],
    ['new card, hard', { easeFactor: 2.5, intervalDays: 0, repetitions: 0 }, 'hard', 2.36, 1, 1],
    ['new card, good', { easeFactor: 2.5, intervalDays: 0, repetitions: 0 }, 'good', 2.5, 1, 1],
    ['new card, easy', { easeFactor: 2.5, intervalDays: 0, repetitions: 0 }, 'easy', 2.6, 1, 1],
    [
      'second review, good',
      { easeFactor: 2.5, intervalDays: 1, repetitions: 1 },
      'good',
      2.5,
      6,
      2,
    ],
    [
      'second review, hard',
      { easeFactor: 2.5, intervalDays: 1, repetitions: 1 },
      'hard',
      2.36,
      6,
      2,
    ],
    [
      'third review, good',
      { easeFactor: 2.5, intervalDays: 6, repetitions: 2 },
      'good',
      2.5,
      15,
      3,
    ],
    [
      'third review, easy',
      { easeFactor: 2.5, intervalDays: 6, repetitions: 2 },
      'easy',
      2.6,
      16,
      3,
    ],
    [
      'third review, hard',
      { easeFactor: 2.5, intervalDays: 6, repetitions: 2 },
      'hard',
      2.36,
      14,
      3,
    ],
    [
      'mature card, good',
      { easeFactor: 2.5, intervalDays: 15, repetitions: 3 },
      'good',
      2.5,
      38,
      4,
    ],
    [
      'mature card, again',
      { easeFactor: 2.5, intervalDays: 15, repetitions: 3 },
      'again',
      2.3,
      0,
      0,
    ],
    ['ease floor on hard', { easeFactor: 1.3, intervalDays: 6, repetitions: 2 }, 'hard', 1.3, 8, 3],
    [
      'ease floor on again',
      { easeFactor: 1.35, intervalDays: 6, repetitions: 2 },
      'again',
      1.3,
      0,
      0,
    ],
    [
      'interval always grows',
      { easeFactor: 1.3, intervalDays: 1, repetitions: 2 },
      'good',
      1.3,
      2,
      3,
    ],
  ];

  it.each(table)('%s', (_name, card, rating, easeFactor, intervalDays, repetitions) => {
    const result = scheduleReview(card, rating, NOW);
    expect(result).toMatchObject({ easeFactor, intervalDays, repetitions });
  });

  it('schedules nextReview intervalDays after now', () => {
    const result = scheduleReview(
      { easeFactor: 2.5, intervalDays: 6, repetitions: 2 },
      'good',
      NOW,
    );
    expect(result.nextReview.getTime()).toBe(NOW.getTime() + 15 * DAY);
  });

  it('brings a lapsed card back after the relearn delay, not a day later', () => {
    const result = scheduleReview(
      { easeFactor: 2.5, intervalDays: 15, repetitions: 3 },
      'again',
      NOW,
    );
    expect(result.nextReview.getTime()).toBe(NOW.getTime() + LAPSE_RELEARN_MINUTES * MINUTE);
  });

  it('uses defaults for a card without scheduling fields', () => {
    expect(scheduleReview({}, 'good', NOW)).toMatchObject({
      easeFactor: 2.5,
      intervalDays: 1,
      repetitions: 1,
    });
  });

  it('never drops the ease factor below the minimum, whatever the history', () => {
    let card = { easeFactor: 2.5, intervalDays: 0, repetitions: 0 };
    for (let i = 0; i < 30; i += 1) card = scheduleReview(card, i % 2 ? 'hard' : 'again', NOW);
    expect(card.easeFactor).toBe(MIN_EASE_FACTOR);
  });

  it('does not mutate its input and rejects unknown ratings', () => {
    const card = Object.freeze({ easeFactor: 2.5, intervalDays: 1, repetitions: 1 });
    expect(() => scheduleReview(card, 'good', NOW)).not.toThrow();
    expect(() => scheduleReview(card, 'perfect', NOW)).toThrow(RangeError);
  });
});
