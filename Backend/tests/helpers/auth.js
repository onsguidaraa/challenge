import request from 'supertest';
import app from '../../src/app.js';

export const API = '/api/v1';

export const validOnboarding = {
  academicLevel: 'undergraduate',
  interests: ['physics', 'music'],
  goals: ['pass calculus'],
  difficulties: ['integrals'],
  preferredFormats: ['visual', 'step_by_step'],
  studyHabits: { bestTimeOfDay: 'evening', preferredSessionMinutes: 45, sessionsPerWeek: 4 },
};

/** Registers a user and returns { id, token }. */
export const registerUser = async (email = 'ada@example.com') => {
  const res = await request(app)
    .post(`${API}/auth/register`)
    .send({ name: 'Test User', email, password: 'password123' });
  return { id: res.body.data.user.id, token: res.body.data.accessToken };
};

export const bearer = (token) => ({ Authorization: `Bearer ${token}` });
