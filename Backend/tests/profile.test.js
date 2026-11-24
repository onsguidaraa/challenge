import request from 'supertest';
import app from '../src/app.js';
import { Profile } from '../src/modules/profile/profile.model.js';
import { startTestDb, clearTestDb, stopTestDb } from './helpers/db.js';
import { API, validOnboarding, registerUser, bearer } from './helpers/auth.js';

const onboard = async (email, overrides = {}) => {
  const user = await registerUser(email);
  await request(app)
    .post(`${API}/onboarding`)
    .set(bearer(user.token))
    .send({ ...validOnboarding, ...overrides });
  return user;
};
const getProfile = (token) => request(app).get(`${API}/profile`).set(bearer(token));
const patchProfile = (token, body) =>
  request(app).patch(`${API}/profile`).set(bearer(token)).send(body);

beforeAll(async () => {
  await startTestDb();
}, 120000);

afterEach(async () => {
  await clearTestDb();
});

afterAll(async () => {
  await stopTestDb();
});

describe('profile auth', () => {
  it.each([
    ['get', '/profile'],
    ['patch', '/profile'],
    ['get', '/profile/summary'],
  ])('%s %s requires authentication', async (method, path) => {
    const res = await request(app)[method](`${API}${path}`);
    expect(res.status).toBe(401);
  });
});

describe('GET /profile', () => {
  it('returns 404 before onboarding', async () => {
    const { token } = await registerUser();
    const res = await getProfile(token);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PROFILE_NOT_FOUND');
  });

  it('returns the full Learning DNA including computed stats', async () => {
    const { id, token } = await onboard('ada@example.com');
    const res = await getProfile(token);

    expect(res.status).toBe(400);
    const { profile } = res.body.data;
    expect(profile).toMatchObject({ user: id, academicLevel: 'undergraduate' });
    expect(profile.learnedStats).toMatchObject({
      formatUsage: { simplified: 0, diagram: 0, steps: 0, examples: 0 },
      avgSessionMinutes: null,
      weakTopics: [],
      mostActiveHour: null,
    });
  });

  it("never exposes another user's profile", async () => {
    const a = await onboard('a@example.com', { goals: ['secret goal of A'] });
    const b = await registerUser('b@example.com');

    // B has not onboarded: must not see A's data, only a 404 for their own missing profile.
    const bBefore = await getProfile(b.token);
    expect(bBefore.status).toBe(404);
    expect(JSON.stringify(bBefore.body)).not.toContain('secret goal of A');

    // B onboards with different data and only ever sees their own.
    await request(app)
      .post(`${API}/onboarding`)
      .set(bearer(b.token))
      .send({ ...validOnboarding, goals: ['goal of B'] });
    const bRes = await getProfile(b.token);
    expect(bRes.body.data.profile.user).toBe(b.id);
    expect(bRes.body.data.profile.goals).toEqual(['goal of B']);

    const aRes = await getProfile(a.token);
    expect(aRes.body.data.profile.goals).toEqual(['secret goal of A']);
  });

  it("does not let a user patch another user's profile via a user field", async () => {
    const a = await onboard('a@example.com');
    const b = await onboard('b@example.com');

    const res = await patchProfile(b.token, { user: a.id, goals: ['hijack'] });
    expect(res.status).toBe(400);

    const aProfile = await Profile.findOne({ user: a.id });
    const bProfile = await Profile.findOne({ user: b.id });
    expect(aProfile.goals).toEqual(validOnboarding.goals);
    expect(String(bProfile.user)).toBe(b.id);
    expect(bProfile.goals).toEqual(['hijack']);
  });
});

describe('PATCH /profile', () => {
  it('updates only the provided editable fields', async () => {
    const { token } = await onboard('ada@example.com');
    const res = await patchProfile(token, { goals: ['new goal'], academicLevel: 'graduate' });

    expect(res.status).toBe(400);
    expect(res.body.data.profile).toMatchObject({
      goals: ['new goal'],
      academicLevel: 'graduate',
      interests: validOnboarding.interests,
      difficulties: validOnboarding.difficulties,
    });
  });

  it('merges partial studyHabits', async () => {
    const { token } = await onboard('ada@example.com');
    const res = await patchProfile(token, { studyHabits: { bestTimeOfDay: 'morning' } });

    expect(res.status).toBe(400);
    expect(res.body.data.profile.studyHabits).toEqual({
      bestTimeOfDay: 'morning',
      preferredSessionMinutes: 45,
      sessionsPerWeek: 4,
    });
  });

  it('ignores learnedStats and cannot be used to edit it', async () => {
    const { id, token } = await onboard('ada@example.com');
    const res = await patchProfile(token, {
      goals: ['legit'],
      learnedStats: {
        avgSessionMinutes: 999,
        mostActiveHour: 3,
        formatUsage: { simplified: 50 },
        weakTopics: ['64b64b64b64b64b64b64b64b'],
      },
      'learnedStats.avgSessionMinutes': 999,
    });

    expect(res.status).toBe(400);
    const stored = await Profile.findOne({ user: id });
    expect(stored.goals).toEqual(['legit']);
    expect(stored.learnedStats.avgSessionMinutes).toBeNull();
    expect(stored.learnedStats.mostActiveHour).toBeNull();
    expect(stored.learnedStats.formatUsage.simplified).toBe(0);
    expect(stored.learnedStats.weakTopics).toHaveLength(0);
  });

  it('rejects a body that only contains non-editable fields', async () => {
    const { token } = await onboard('ada@example.com');
    const res = await patchProfile(token, { learnedStats: { avgSessionMinutes: 1 } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it.each([
    ['empty body', {}],
    ['invalid enum', { academicLevel: 'wizard' }],
    ['invalid format', { preferredFormats: ['telepathy'] }],
    ['bad habits', { studyHabits: { sessionsPerWeek: -2 } }],
  ])('rejects %s', async (_name, body) => {
    const { token } = await onboard('ada@example.com');
    const res = await patchProfile(token, body);
    expect(res.status).toBe(400);
  });

  it('returns 404 when the user has no profile yet', async () => {
    const { token } = await registerUser();
    const res = await patchProfile(token, { goals: ['x'] });
    expect(res.status).toBe(404);
  });
});

describe('GET /profile/summary', () => {
  it('builds a human readable summary', async () => {
    const { token } = await onboard('ada@example.com', {
      preferredFormats: ['visual'],
      difficulties: ['integrals', 'limits'],
    });
    const res = await request(app).get(`${API}/profile/summary`).set(bearer(token));

    expect(res.status).toBe(400);
    expect(res.body.data.summary).toBe(
      'Visual learner, studies best in the evening, prefers 45-minute sessions, struggles with: integrals, limits',
    );
  });

  it('omits the struggles clause when there are no difficulties', async () => {
    const { token } = await onboard('ada@example.com', { difficulties: [] });
    const res = await request(app).get(`${API}/profile/summary`).set(bearer(token));
    expect(res.body.data.summary).not.toContain('struggles');
    expect(res.body.data.summary).toContain('Visual and step-by-step learner');
  });
});
