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

## Therapist Profile (`/api/v1/therapist-profile`)

- `GET /` – get logged-in therapist profile (therapist auth required)
- `PATCH /` – create/update logged-in therapist profile (therapist auth required)

## Quiz Management (`/api/v1/users`)

- `POST /create-quiz` – create a quiz (admin only)
- `POST /submit-quiz` – submit quiz answers
- `POST /calculate` – compute 16PF scores

## Support Tickets (`/api/v1/tickets`)

- `POST /` – create a support ticket, optional image upload (auth required)
- `GET /` – list existing tickets (auth required)

To run the server, configure your `config.env` file and execute `npm start`.



0️⃣ Greeting & Purpose

“Hi {FirstName}, I’m Zen from Zengarden. I’ll help you set up your profile so booking sessions is easy. This will take about 2 minutes. Ready to begin?”

If Yes → Continue

If No → Exit onboarding

1️⃣ What Brings You Here

“What brings you here today?”

Optional quick choices:

Stress

Anxiety

Work burnout

Relationships

Sleep

Other

Store: primaryConcern

2️⃣ Therapist Gender Preference

“Do you have a preference for therapist gender — male, female, or no preference?”

Store: therapistGenderPref

3️⃣ Language Preference

“Which language would you like to use during your sessions?”

(Default to app language if detected)

Store: languagePref

4️⃣ Session Format

“Sessions are conducted via Zoom video calls. Does that work for you?”

Yes

Prefer something else (if supported)

Store: sessionMode

5️⃣ Availability

“When are you usually available for sessions?”

Options:

Weekdays

Weekends

Mornings

Afternoons

Evenings

Flexible

Store: availabilityPrefs

6️⃣ Timezone Confirmation

“I detected your timezone as {DetectedTimezone}. Is that correct?”

Yes

No → Ask: “What timezone are you in?”

Store: timezone

7️⃣ Reminder Preference

“How would you like to receive session reminders?”

Options:

Email

SMS / WhatsApp (if supported)

No reminders

Store: reminderChannel

8️⃣ Trusted Contact (Optional Safety Step)

“Would you like to add a trusted contact we can notify only if you explicitly request it in the future?”

Yes → Open input modal:

Name

Email

Relationship

No → Continue

Store: trustedContact

9️⃣ Summary & Confirmation

“Here’s what I’ve saved:”

Primary concern

Therapist preference

Availability

Timezone

“Does everything look correct?”

Confirm

Edit something → Ask which field to update

🔟 Completion

“All set 🎉 Would you like me to show available therapists now?”

Options:

Show therapists

Book a session
