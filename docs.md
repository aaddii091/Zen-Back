# Zen Backend Services Documentation

This document provides a quick overview of the available REST endpoints in the Node.js/Express API.

## Authentication (`/api/v1/users`)

- `POST /signup` – register a new user
- `POST /login` – user login
- `POST /forgotPassword` – send password reset link
- `POST /resetPassword/:token` – reset password
- `POST /updatePassword` – update password (auth required)
- `GET /getUserQuizzes` – list quizzes accessible to the user (auth required)
- `POST /getQuizByID` – fetch a quiz by ID (auth required)

## Quiz Management (`/api/v1/users`)

- `POST /create-quiz` – create a quiz (admin only)
- `POST /submit-quiz` – submit quiz answers
- `POST /calculate` – compute 16PF scores

## Support Tickets (`/api/v1/tickets`)

- `POST /` – create a support ticket, optional image upload (auth required)
- `GET /` – list existing tickets (auth required)

To run the server, configure your `config.env` file and execute `npm start`.
