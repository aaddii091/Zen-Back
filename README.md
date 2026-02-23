# Zen-Back

Express + MongoDB backend for Zengarden.

This service powers:
- user / therapist authentication
- onboarding and profile data
- therapist assignment to users
- therapist profile management
- Calendly OAuth connection for therapists
- booking ingestion through Calendly webhooks
- therapist schedule and bookings APIs
- quizzes, tickets, organizations, and voice session APIs

## Tech Stack

- Node.js
- Express
- MongoDB + Mongoose
- JWT auth

## Run Locally

1. Install dependencies

```bash
npm install
```

2. Configure environment in `config.env`

Required core keys:
- `PORT`
- `DATABASE`
- `JWT_SECRET`
- `JWT_EXPIRES_IN`

Calendly integration keys:
- `CALENDLY_CLIENT_ID`
- `CALENDLY_CLIENT_SECRET`
- `CALENDLY_REDIRECT_URI`
- `CALENDLY_CONNECT_REDIRECT_FRONTEND`

3. Start server

```bash
npm start
```

Server entry:
- `server.js` (DB bootstrap)
- `index.js` (Express app, middleware, route mounting)

## High-Level Architecture

Request flow:
- `routes/*` receives request
- auth middleware from `controllers/authController.js` validates JWT and role
- business logic in `controllers/*`
- persistence via `models/*`

Main route mounts in `index.js`:
- `/api/v1/users`
- `/api/v1/tickets`
- `/api/v1/organizations`
- `/api/v1/voice`
- `/api/v1/user-info`
- `/api/v1/therapist-profile`
- `/api/v1/calendly`

## Directory Map

```text
controllers/
  authController.js              auth + roles + assignment + me
  therapistProfileController.js  therapist profile CRUD (self)
  calendlyController.js          OAuth, status, today sessions, webhook, bookings
  quizController.js
  ticketController.js
  organizationController.js
  userInfoController.js

models/
  userModel.js
  therapistProfileModel.js
  appointmentModel.js            persisted bookings from Calendly webhook
  userInfoModel.js
  quizModel.js
  16PFAnswerModel.js
  ticketModel.js
  organizationModel.js

routes/
  userRoutes.js
  therapistProfileRoutes.js
  calendlyRoutes.js
  quizRoutes.js
  ticketRoutes.js
  organizationRoutes.js
  userInfoRoutes.js
  voiceRoutes.js

utils/
  catchAsync.js
  appError.js
  email.js
```

## Auth and Roles

User roles in `userModel`:
- `user`
- `therapist`
- `admin`

Role middleware in `authController`:
- `protect`
- `isAdmin`
- `isTherapist`

## Core API Surface

### Users (`/api/v1/users`)

- `POST /signup`
- `POST /login`
- `GET /me` (auth)
- `GET /assigned-therapist` (auth)
- `PATCH /:id/assign-therapist` (admin)
- password + quiz endpoints (existing)

### Therapist Profile (`/api/v1/therapist-profile`)

- `GET /` (therapist)
- `PATCH /` (therapist)

Fields include bio/professional profile and Calendly metadata.

### Calendly (`/api/v1/calendly`)

- `GET /connect-url` (therapist)
- `GET /callback` (OAuth redirect target)
- `POST /webhook` (Calendly webhook receiver)
- `GET /status` (therapist)
- `GET /today-sessions` (therapist)
- `GET /my-bookings` (therapist)
- `POST /disconnect` (therapist)

## Booking Data Model

`appointmentModel` stores booking ownership and schedule data:
- `user`, `therapist`
- `userName`, `userEmail`, `therapistName`, `therapistEmail`
- `scheduledAt`, `endsAt`, `timezone`, `sessionType`, `status`
- `calendlyEventUri`, `calendlyInviteeUri`
- `tracking` (utm/context)
- `rawPayload` (webhook payload snapshot)

## Calendly Integration Flow

Therapist onboarding:
1. Therapist logs in to admin app.
2. Admin app requests `/api/v1/calendly/connect-url`.
3. Therapist authorizes in Calendly.
4. Calendly redirects to `/api/v1/calendly/callback`.
5. Backend stores Calendly identity + tokens in `therapistProfile`.

User booking flow:
1. User app opens therapist `calendlyUrl` with query params (`name`, `email`, tracking IDs).
2. User books in Calendly.
3. Calendly sends webhook to `POST /api/v1/calendly/webhook`.
4. Backend upserts booking in `appointments`.
5. Therapist dashboard reads `/api/v1/calendly/today-sessions` and `/api/v1/calendly/my-bookings`.

## Important Notes

- `POST /api/v1/calendly/webhook` currently accepts payload without signature verification. Add verification before production hardening.
- CORS is currently broad/open in `index.js`.
- `today-sessions` enriches Calendly events with local appointment ownership where available.

## Developer Navigation Tips

- Start with `index.js` to see all mounted modules.
- For anything auth-related, open `controllers/authController.js` first.
- For therapist onboarding and booking ingestion, open `controllers/calendlyController.js` and `models/appointmentModel.js`.
- For assigned therapist lookup used by UserSide, use `getAssignedTherapist` in `authController`.
