# Student Learning Platform Backend

Node.js 20+, Express, MongoDB/Mongoose, JWT, and Zod API. Configure `.env`
from `.env.example`, then run `npm install`, `npm run dev` from this directory.

## Endpoints

All API routes are prefixed by `/api/v1`; authenticated routes require
`Authorization: Bearer <accessToken>`.

| Area | Routes |
| --- | --- |
| Health | `GET /health` |
| Authentication | `POST /auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout`; `GET /auth/me`; `DELETE /auth/me` |
| Onboarding, profile | `/onboarding/*`, `/profile/*` |
| Learning | `/topics/*`, `/quizzes/*`, `/flashcards/*`, `/mistakes/*` |
| Planner and progress | `/plans/*`, `/tasks/*`, `/sessions/*`, `/planner/*`, `/progress/*` |
| AI placeholders | `GET /ai/status`, `POST /ai/chat` (no AI processing) |

The full request and response schemas are defined in each module's validation,
controller, and service files. A starter Postman collection is in
`docs/postman_collection.json`.

## Seed credentials

No seed script or seeded credentials are currently available. Register a user
with `POST /api/v1/auth/register` for local testing.

## Frontend integration

1. Use `/api/v1/auth/register` or `/api/v1/auth/login` and retain the returned
   access token in memory; avoid persistent browser storage for bearer tokens.
2. Send `Authorization: Bearer <accessToken>` on authenticated requests.
3. On `401`, exchange the refresh token at `/api/v1/auth/refresh`, serialize
   refresh requests to avoid token rotation races, and retry once.
4. Use the response envelope `{ success, data, message }`; errors use
   `{ success: false, error: { code, message, details } }`.
5. Configure `CORS_ORIGIN` to the exact frontend origin(s).

## Development checks

Run `npm test` and `npm run lint` from `Backend/`. AI integrations and the
future modules listed in `docs/FUTURE_FEATURES.md` are deliberately not active.
