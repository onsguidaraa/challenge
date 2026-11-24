import request from 'supertest';
import app from '../src/app.js';
import { User } from '../src/modules/auth/auth.model.js';
import { Profile } from '../src/modules/profile/profile.model.js';
import { ActivityLog } from '../src/modules/activity-log/activity-log.model.js';
import { startTestDb, clearTestDb, stopTestDb } from './helpers/db.js';
import { API, validOnboarding, registerUser, bearer } from './helpers/auth.js';

const post = (token, body) => request(app).post(`${API}/onboarding`).set(bearer(token)).send(body);

beforeAll(async () => {
  await startTestDb();
}, 120000);

afterEach(async () => {
  await clearTestDb();
});

afterAll(async () => {
  await stopTestDb();
});

describe('onboarding auth', () => {
  it('requires authentication', async () => {
    expect((await request(app).post(`${API}/onboarding`).send(validOnboarding)).status).toBe(401);
    expect((await request(app).get(`${API}/onboarding/status`)).status).toBe(401);
  });
});

describe('POST /onboarding validation', () => {
  const cases = {
    'missing academicLevel': { academicLevel: undefined },
    'invalid academicLevel': { academicLevel: 'wizard' },
    'empty interests': { interests: [] },
    'non-array goals': { goals: 'pass' },
    'blank difficulty entry': { difficulties: ['  '] },
    'empty preferredFormats': { preferredFormats: [] },
    'invalid preferredFormats': { preferredFormats: ['telepathy'] },
    'missing studyHabits': { studyHabits: undefined },
    'invalid bestTimeOfDay': {
      studyHabits: { ...validOnboarding.studyHabits, bestTimeOfDay: 'noon' },
    },
    'non-integer session minutes': {
      studyHabits: { ...validOnboarding.studyHabits, preferredSessionMinutes: 'long' },
    },
    'sessionsPerWeek out of range': {
      studyHabits: { ...validOnboarding.studyHabits, sessionsPerWeek: 0 },
    },
  };

  it.each(Object.entries(cases))('rejects %s with 400', async (_name, override) => {
    const { token } = await registerUser();
    const res = await post(token, { ...validOnboarding, ...override });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.length).toBeGreaterThan(0);

    const user = await User.findOne({ email: 'ada@example.com' });
    expect(user.onboardingCompleted).toBe(false);
    expect(await Profile.countDocuments()).toBe(0);
  });
});

describe('POST /onboarding', () => {
  it('creates the profile, flips onboardingCompleted and logs an event', async () => {
    const { id, token } = await registerUser();
    const res = await post(token, { ...validOnboarding, interests: [' physics ', 'physics'] });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.completed).toBe(true);
    expect(res.body.data.profile).toMatchObject({
      user: id,
      academicLevel: 'undergraduate',
      interests: ['physics'],
      preferredFormats: ['visual', 'step_by_step'],
      studyHabits: { bestTimeOfDay: 'evening', preferredSessionMinutes: 45, sessionsPerWeek: 4 },
    });

    const user = await User.findById(id);
    expect(user.onboardingCompleted).toBe(true);

    const events = await ActivityLog.find({ user: id, type: 'onboarding_completed' });
    expect(events).toHaveLength(1);
    expect(events[0].refModel).toBe('Profile');
  });

  it('returns 409 when already completed and no retake flag', async () => {
    const { token } = await registerUser();
    expect((await post(token, validOnboarding)).status).toBe(200);

    const res = await post(token, { ...validOnboarding, academicLevel: 'graduate' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ONBOARDING_ALREADY_COMPLETED');

    const profile = await Profile.findOne();
    expect(profile.academicLevel).toBe('undergraduate');

    const explicitFalse = await post(token, { ...validOnboarding, retake: false });
    expect(explicitFalse.status).toBe(409);
  });

  it('updates the same profile when retake is true, keeping learnedStats', async () => {
    const { id, token } = await registerUser();
    await post(token, validOnboarding);
    await Profile.updateOne({ user: id }, { $set: { 'learnedStats.avgSessionMinutes': 30 } });

    const res = await post(token, {
      ...validOnboarding,
      academicLevel: 'graduate',
      goals: ['finish thesis'],
      retake: true,
    });

    expect(res.status).toBe(200);
    expect(res.body.data.profile.academicLevel).toBe('graduate');
    expect(res.body.data.profile.goals).toEqual(['finish thesis']);
    expect(res.body.data.profile.learnedStats.avgSessionMinutes).toBe(30);
    expect(await Profile.countDocuments({ user: id })).toBe(1);
    expect(await ActivityLog.countDocuments({ user: id, type: 'onboarding_completed' })).toBe(2);
  });
});

describe('GET /onboarding/status', () => {
  it('reports not completed with no answers before onboarding', async () => {
    const { token } = await registerUser();
    const res = await request(app).get(`${API}/onboarding/status`).set(bearer(token));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ completed: false, answers: null });
  });

  it('returns saved answers after onboarding', async () => {
    const { token } = await registerUser();
    await post(token, validOnboarding);
    const res = await request(app).get(`${API}/onboarding/status`).set(bearer(token));

    expect(res.status).toBe(200);
    expect(res.body.data.completed).toBe(true);
    expect(res.body.data.answers).toEqual(validOnboarding);
  });
});
