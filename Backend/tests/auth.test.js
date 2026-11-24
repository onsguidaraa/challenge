import request from 'supertest';
import app from '../src/app.js';
import { User } from '../src/modules/auth/auth.model.js';
import { startTestDb, clearTestDb, stopTestDb } from './helpers/db.js';

const API = '/api/v1';
const validUser = { name: 'Ada Lovelace', email: 'ada@example.com', password: 'password123' };

const register = (body = validUser) => request(app).post(`${API}/auth/register`).send(body);
const login = (body) => request(app).post(`${API}/auth/login`).send(body);

beforeAll(async () => {
  await startTestDb();
}, 120000);

afterEach(async () => {
  await clearTestDb();
});

afterAll(async () => {
  await stopTestDb();
});

describe('GET /health', () => {
  it('returns status and uptime', async () => {
    const res = await request(app).get(`${API}/health`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('ok');
    expect(typeof res.body.data.uptime).toBe('number');
  });
});

describe('unknown routes', () => {
  it('returns a 404 in the standard error format', async () => {
    const res = await request(app).get(`${API}/nope`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'ROUTE_NOT_FOUND', message: expect.any(String), details: null },
    });
  });
});

describe('POST /auth/register', () => {
  it('creates a user and returns tokens without sensitive fields', async () => {
    const res = await register();

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    const { user, accessToken, refreshToken } = res.body.data;
    expect(accessToken).toEqual(expect.any(String));
    expect(refreshToken).toEqual(expect.any(String));
    expect(user).toMatchObject({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      role: 'student',
      onboardingCompleted: false,
      xp: 0,
      badges: [],
      streak: { current: 0, longest: 0, lastActiveDate: null },
    });
    expect(user.passwordHash).toBeUndefined();
    expect(user.refreshTokens).toBeUndefined();
  });

  it('stores a bcrypt password hash and only a hashed refresh token', async () => {
    const res = await register();
    const { refreshToken } = res.body.data;

    const stored = await User.findOne({ email: validUser.email }).select(
      '+passwordHash +refreshTokens',
    );
    expect(stored.passwordHash).not.toBe(validUser.password);
    expect(stored.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(stored.refreshTokens).toHaveLength(1);
    expect(stored.refreshTokens[0].tokenHash).not.toBe(refreshToken);
    expect(stored.refreshTokens[0].tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.refreshTokens[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('normalizes the email to lowercase', async () => {
    const res = await register({ ...validUser, email: '  ADA@Example.com ' });
    expect(res.status).toBe(201);
    expect(res.body.data.user.email).toBe('ada@example.com');
  });

  it('does not let clients choose their role', async () => {
    const res = await register({ ...validUser, role: 'admin' });
    expect(res.status).toBe(201);
    expect(res.body.data.user.role).toBe('student');
  });

  it('rejects a duplicate email (case-insensitive) with 409', async () => {
    await register();
    const res = await register({ ...validUser, email: 'ADA@example.com' });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
    expect(await User.countDocuments()).toBe(1);
  });

  it('rejects passwords shorter than 8 characters', async () => {
    const res = await register({ ...validUser, password: 'short' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details[0].field).toBe('password');
    expect(await User.countDocuments()).toBe(0);
  });

  it('rejects an invalid email and missing name', async () => {
    const res = await register({ email: 'not-an-email', password: 'password123' });

    expect(res.status).toBe(400);
    const fields = res.body.error.details.map((d) => d.field);
    expect(fields).toEqual(expect.arrayContaining(['email', 'name']));
  });

  it('returns 400 for malformed JSON', async () => {
    const res = await request(app)
      .post(`${API}/auth/register`)
      .set('Content-Type', 'application/json')
      .send('{"name": ');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });
});

describe('POST /auth/login', () => {
  beforeEach(async () => {
    await register();
  });

  it('logs in with valid credentials', async () => {
    const res = await login({ email: 'ADA@example.com', password: validUser.password });

    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toEqual(expect.any(String));
    expect(res.body.data.refreshToken).toEqual(expect.any(String));
    expect(res.body.data.user.email).toBe(validUser.email);
    expect(res.body.data.user.passwordHash).toBeUndefined();
  });

  it('rejects a wrong password with 401', async () => {
    const res = await login({ email: validUser.email, password: 'wrong-password' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('rejects an unknown email with the same 401 error', async () => {
    const res = await login({ email: 'ghost@example.com', password: validUser.password });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('validates the body', async () => {
    const res = await login({ email: 'bad' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /auth/me', () => {
  it('returns 401 without a token', async () => {
    const res = await request(app).get(`${API}/auth/me`);

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('AUTH_REQUIRED');
  });

  it('returns 401 for an invalid token', async () => {
    const res = await request(app).get(`${API}/auth/me`).set('Authorization', 'Bearer not.a.token');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
  });

  it('rejects a refresh token used as an access token', async () => {
    const { body } = await register();
    const res = await request(app)
      .get(`${API}/auth/me`)
      .set('Authorization', `Bearer ${body.data.refreshToken}`);

    expect(res.status).toBe(401);
  });

  it('returns the current user with a valid token', async () => {
    const { body } = await register();
    const res = await request(app)
      .get(`${API}/auth/me`)
      .set('Authorization', `Bearer ${body.data.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe(validUser.email);
    expect(res.body.data.user.passwordHash).toBeUndefined();
    expect(res.body.data.user.refreshTokens).toBeUndefined();
    expect(res.body.data.accessToken).toBeUndefined();
  });
});

describe('POST /auth/refresh', () => {
  const refresh = (refreshToken) => request(app).post(`${API}/auth/refresh`).send({ refreshToken });

  it('rotates the refresh token and invalidates the old one', async () => {
    const { body } = await register();
    const oldRefresh = body.data.refreshToken;

    const res = await refresh(oldRefresh);
    expect(res.status).toBe(200);
    const { accessToken, refreshToken: newRefresh } = res.body.data;
    expect(newRefresh).toEqual(expect.any(String));
    expect(newRefresh).not.toBe(oldRefresh);

    // new access token works
    const me = await request(app)
      .get(`${API}/auth/me`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(me.status).toBe(200);

    // old token can no longer be used
    const reuse = await refresh(oldRefresh);
    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe('INVALID_REFRESH_TOKEN');

    // reuse of a rotated token is treated as theft: every session of the user is revoked
    const stored = await User.findOne({ email: validUser.email }).select('+refreshTokens');
    expect(stored.refreshTokens).toHaveLength(0);
  });

  it('keeps the new token valid when rotated normally', async () => {
    const { body } = await register();
    const first = await refresh(body.data.refreshToken);
    const second = await refresh(first.body.data.refreshToken);

    expect(second.status).toBe(200);
    const stored = await User.findOne({ email: validUser.email }).select('+refreshTokens');
    expect(stored.refreshTokens).toHaveLength(1);
  });

  it('revokes all sessions when an old token is reused', async () => {
    const { body } = await register();
    const rotated = await refresh(body.data.refreshToken);

    await refresh(body.data.refreshToken); // reuse of the old token
    const afterReuse = await refresh(rotated.body.data.refreshToken);
    expect(afterReuse.status).toBe(401);
  });

  it('rejects garbage tokens', async () => {
    const res = await refresh('garbage');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_REFRESH_TOKEN');
  });

  it('rejects an access token sent as a refresh token', async () => {
    const { body } = await register();
    const res = await refresh(body.data.accessToken);
    expect(res.status).toBe(401);
  });

  it('requires a refreshToken in the body', async () => {
    const res = await request(app).post(`${API}/auth/refresh`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /auth/logout', () => {
  const logout = (refreshToken) => request(app).post(`${API}/auth/logout`).send({ refreshToken });

  it('revokes the refresh token', async () => {
    const { body } = await register();
    const { refreshToken } = body.data;

    const res = await logout(refreshToken);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const stored = await User.findOne({ email: validUser.email }).select('+refreshTokens');
    expect(stored.refreshTokens).toHaveLength(0);

    const refreshed = await request(app).post(`${API}/auth/refresh`).send({ refreshToken });
    expect(refreshed.status).toBe(401);
  });

  it('only revokes the given session', async () => {
    const first = await register();
    const second = await login({ email: validUser.email, password: validUser.password });

    await logout(first.body.data.refreshToken);

    const res = await request(app)
      .post(`${API}/auth/refresh`)
      .send({ refreshToken: second.body.data.refreshToken });
    expect(res.status).toBe(200);
  });

  it('is idempotent', async () => {
    const { body } = await register();
    await logout(body.data.refreshToken);
    const again = await logout(body.data.refreshToken);
    expect(again.status).toBe(200);
  });
});
