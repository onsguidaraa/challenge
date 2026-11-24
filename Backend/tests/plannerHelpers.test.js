import {
  calculateProgress,
  computeDurationMinutes,
  getRangeBounds,
  groupTasksByDate,
  isSessionStale,
  nextOccurrenceDate,
} from '../src/modules/planner/planner.helpers.js';

const d = (value) => new Date(value);

describe('calculateProgress', () => {
  it('is the percentage of done tasks, rounded', () => {
    expect(calculateProgress({ total: 4, done: 1 })).toBe(25);
    expect(calculateProgress({ total: 3, done: 1 })).toBe(33);
    expect(calculateProgress({ total: 3, done: 2 })).toBe(67);
    expect(calculateProgress({ total: 5, done: 5 })).toBe(100);
  });

  it('is 0 when there are no tasks or none is done', () => {
    expect(calculateProgress()).toBe(0);
    expect(calculateProgress({ total: 0, done: 0 })).toBe(0);
    expect(calculateProgress({ total: 3, done: 0 })).toBe(0);
  });

  it('leaves skipped tasks out of the calculation', () => {
    expect(calculateProgress({ total: 4, done: 1, skipped: 1 })).toBe(33);
    expect(calculateProgress({ total: 2, done: 2, skipped: 0 })).toBe(100);
    expect(calculateProgress({ total: 2, done: 0, skipped: 2 })).toBe(0);
  });
});

describe('computeDurationMinutes', () => {
  it('is the elapsed minutes, rounded to 1 decimal', () => {
    expect(computeDurationMinutes(d('2026-05-01T10:00:00Z'), d('2026-05-01T10:25:00Z'))).toBe(25);
    expect(computeDurationMinutes(d('2026-05-01T10:00:00Z'), d('2026-05-01T10:00:50Z'))).toBe(0.8);
    expect(computeDurationMinutes(d('2026-05-01T10:00:00Z'), d('2026-05-01T12:30:00Z'))).toBe(150);
  });

  it('never goes negative', () => {
    expect(computeDurationMinutes(d('2026-05-01T10:00:00Z'), d('2026-05-01T09:00:00Z'))).toBe(0);
  });
});

describe('isSessionStale', () => {
  const now = d('2026-05-02T00:00:00Z');
  it('is true from 12 hours on', () => {
    expect(isSessionStale(d('2026-05-01T12:00:00Z'), now)).toBe(true);
    expect(isSessionStale(d('2026-05-01T12:00:01Z'), now)).toBe(false);
  });
});

describe('nextOccurrenceDate', () => {
  const dueDate = d('2026-05-01T09:00:00Z');

  it('adds one day for daily and seven for weekly', () => {
    expect(nextOccurrenceDate({ dueDate, recurrence: { type: 'daily' } })).toEqual(
      d('2026-05-02T09:00:00Z'),
    );
    expect(nextOccurrenceDate({ dueDate, recurrence: { type: 'weekly' } })).toEqual(
      d('2026-05-08T09:00:00Z'),
    );
  });

  it('returns null without recurrence or due date', () => {
    expect(nextOccurrenceDate({ dueDate, recurrence: { type: 'none' } })).toBeNull();
    expect(nextOccurrenceDate({ dueDate })).toBeNull();
    expect(nextOccurrenceDate({ dueDate: null, recurrence: { type: 'daily' } })).toBeNull();
  });

  it('stops after the until date (inclusive)', () => {
    const until = d('2026-05-02T09:00:00Z');
    expect(nextOccurrenceDate({ dueDate, recurrence: { type: 'daily', until } })).toEqual(until);
    expect(nextOccurrenceDate({ dueDate: until, recurrence: { type: 'daily', until } })).toBeNull();
  });
});

describe('getRangeBounds', () => {
  // 2026-05-06 is a Wednesday.
  const date = d('2026-05-06T15:30:00Z');

  it('day: that UTC day', () => {
    expect(getRangeBounds('day', date)).toEqual({
      from: d('2026-05-06T00:00:00Z'),
      to: d('2026-05-07T00:00:00Z'),
    });
  });

  it('week: Monday to Sunday', () => {
    expect(getRangeBounds('week', date)).toEqual({
      from: d('2026-05-04T00:00:00Z'),
      to: d('2026-05-11T00:00:00Z'),
    });
    // A Sunday belongs to the week that started on the previous Monday.
    expect(getRangeBounds('week', d('2026-05-10T23:00:00Z')).from).toEqual(
      d('2026-05-04T00:00:00Z'),
    );
    expect(getRangeBounds('week', d('2026-05-04T00:00:00Z')).from).toEqual(
      d('2026-05-04T00:00:00Z'),
    );
  });

  it('month: the calendar month', () => {
    expect(getRangeBounds('month', date)).toEqual({
      from: d('2026-05-01T00:00:00Z'),
      to: d('2026-06-01T00:00:00Z'),
    });
    expect(getRangeBounds('month', d('2026-12-15T00:00:00Z')).to).toEqual(
      d('2027-01-01T00:00:00Z'),
    );
  });

  it('rejects unknown ranges', () => {
    expect(() => getRangeBounds('year', date)).toThrow(RangeError);
  });
});

describe('groupTasksByDate', () => {
  it('groups by UTC date, dates ascending, tasks by due time', () => {
    const tasks = [
      { id: 'c', dueDate: d('2026-05-03T08:00:00Z') },
      { id: 'b', dueDate: d('2026-05-01T18:00:00Z') },
      { id: 'a', dueDate: d('2026-05-01T09:00:00Z') },
      { id: 'x', dueDate: null },
    ];
    expect(groupTasksByDate(tasks)).toEqual([
      { date: '2026-05-01', tasks: [tasks[2], tasks[1]] },
      { date: '2026-05-03', tasks: [tasks[0]] },
    ]);
  });

  it('returns an empty list for no tasks', () => {
    expect(groupTasksByDate([])).toEqual([]);
  });
});
