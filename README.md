# Zen-Back

Zen-Back is a Node.js/Express backend that provides JWT based authentication, quiz management and a simple support ticket system. MongoDB is used for data storage via Mongoose.

## Getting Started

1. **Install dependencies**
   ```bash
   npm install
   ```
2. **Environment variables**
   Create a `config.env` file in the project root. At minimum the following variables are used:
   - `DATABASE` – Mongo connection string
   - `JWT_SECRET` – secret for signing tokens
   - `JWT_EXPIRES_IN` – token lifetime (e.g. `90d`)
   - Additional mail settings are required if password reset emails are used (`EMAIL_HOST`, `EMAIL_PORT`, `EMAIL_USERNAME`, `EMAIL_PASSWORD`).
3. **Run the server**
   ```bash
   npm start
   ```
   The API will start on the port defined in `config.env` or `3000` by default.

## Project Structure

```
controllers/  -> route handler logic
models/       -> mongoose schemas
routes/       -> Express route definitions
utils/        -> helper utilities (error handling, email, etc.)
index.js      -> express app with routes
server.js     -> application entry point and database connection
```

## API Overview

### Authentication

User signup, login and password utilities are handled in `routes/userRoutes.js`.

### Quizzes

Admins can create quizzes and users can submit answers through the endpoints defined in `routes/quizRoutes.js`.

### Support Tickets

Support ticket endpoints are mounted at `/api/v1/tickets`.

- `POST /api/v1/tickets`
  - Create a ticket. Requires authentication.
  - Body fields: `title` (string), `message` (string), optional `file` and `organization`.
- `GET /api/v1/tickets`
  - Retrieve tickets. Non‑admin users receive only their own tickets.
  - Admin users see all tickets and may filter by `organization` or `user` query parameters.

## Development

The project uses nodemon for development. Running `npm start` will automatically restart the server when files change.

***
