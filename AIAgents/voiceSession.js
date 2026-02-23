const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');

const onboardingTools = [
  {
    type: 'function',
    name: 'set_onboarding_readiness',
    parameters: {
      type: 'object',
      properties: {
        ready: { type: 'boolean' },
        action: {
          type: 'string',
          enum: ['continue', 'exit'],
        },
      },
      required: ['ready', 'action'],
    },
  },
  {
    type: 'function',
    name: 'set_primary_concern',
    parameters: {
      type: 'object',
      properties: {
        primaryConcern: {
          type: 'string',
          enum: [
            'stress',
            'anxiety',
            'work_burnout',
            'relationships',
            'sleep',
            'other',
          ],
        },
      },
      required: ['primaryConcern'],
    },
  },
  {
    type: 'function',
    name: 'set_therapist_gender_pref',
    parameters: {
      type: 'object',
      properties: {
        therapistGenderPref: {
          type: 'string',
          enum: ['male', 'female', 'no_preference'],
        },
      },
      required: ['therapistGenderPref'],
    },
  },
  {
    type: 'function',
    name: 'set_language_pref',
    parameters: {
      type: 'object',
      properties: {
        languagePref: { type: 'string' },
      },
      required: ['languagePref'],
    },
  },
  {
    type: 'function',
    name: 'set_session_mode',
    parameters: {
      type: 'object',
      properties: {
        sessionMode: {
          type: 'string',
          enum: ['zoom_video', 'prefer_something_else'],
        },
      },
      required: ['sessionMode'],
    },
  },
  {
    type: 'function',
    name: 'set_availability_prefs',
    parameters: {
      type: 'object',
      properties: {
        availabilityPrefs: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'weekdays',
              'weekends',
              'mornings',
              'afternoons',
              'evenings',
              'flexible',
            ],
          },
        },
      },
      required: ['availabilityPrefs'],
    },
  },
  {
    type: 'function',
    name: 'set_reminder_channel',
    parameters: {
      type: 'object',
      properties: {
        reminderChannel: {
          type: 'string',
          enum: ['email', 'sms_whatsapp', 'no_reminders'],
        },
      },
      required: ['reminderChannel'],
    },
  },
  {
    type: 'function',
    name: 'set_trusted_contact_pref',
    parameters: {
      type: 'object',
      properties: {
        addTrustedContact: {
          type: 'boolean',
        },
      },
      required: ['addTrustedContact'],
    },
  },
  {
    type: 'function',
    name: 'request_trusted_contact_form',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          enum: ['collect_trusted_contact_details'],
        },
      },
      required: ['reason'],
    },
  },
  {
    type: 'function',
    name: 'confirm_onboarding_summary',
    parameters: {
      type: 'object',
      properties: {
        confirmed: {
          type: 'boolean',
        },
        editField: {
          type: 'string',
          enum: [
            'primaryConcern',
            'therapistGenderPref',
            'languagePref',
            'sessionMode',
            'availabilityPrefs',
            'reminderChannel',
            'trustedContact',
          ],
        },
      },
      required: ['confirmed'],
    },
  },
  {
    type: 'function',
    name: 'complete_onboarding',
    parameters: {
      type: 'object',
      properties: {
        nextAction: {
          type: 'string',
          enum: ['show_available_therapists', 'end_for_now'],
        },
      },
      required: ['nextAction'],
    },
  },
];

const buildOnboardingInstructions = ({
  firstName = 'there',
  appLanguage = 'English',
  detectedTimezone,
} = {}) => `
You are Zen for Zengarden onboarding. Keep answers <=2 short sentences.
After each valid answer: acknowledge briefly ("Okay, got it.") then continue.
Ask one question at a time and call the matching tool immediately after capture.
If unclear, ask one short clarification question.

Start with:
"Hi ${firstName}, I’m Zen from Zengarden. I’ll help you set up your profile so booking sessions is easy. This will take about 2 minutes. Ready to begin?"
- yes -> set_onboarding_readiness {ready:true, action:"continue"}
- no/not now -> set_onboarding_readiness {ready:false, action:"exit"} + "No problem. We can continue this later. Have a great day." and end

Flow:
1) "What brings you here today?" (stress|anxiety|work_burnout|relationships|sleep|other) -> set_primary_concern
2) "Do you have a preference for therapist gender — male, female, or no preference?" -> set_therapist_gender_pref
3) "Which language would you like to use during your sessions?" (default=${appLanguage}) -> set_language_pref
4) "Sessions are conducted via Zoom video calls. Does that work for you?" (yes|prefer_something_else) -> set_session_mode
5) "When are you usually available for sessions?" (weekdays, weekends, mornings, afternoons, evenings, flexible; multi-select) -> set_availability_prefs
6) "How would you like to receive session reminders?" (email|sms_whatsapp|no_reminders) -> set_reminder_channel
7) "Would you like to add a trusted contact we can notify only if you explicitly request it in the future?"
   - yes -> set_trusted_contact_pref {addTrustedContact:true}, then request_trusted_contact_form {reason:"collect_trusted_contact_details"}
   - no -> set_trusted_contact_pref {addTrustedContact:false}
8) Give summary (primaryConcern, therapistGenderPref, languagePref, sessionMode, availabilityPrefs, reminderChannel, trustedContact${detectedTimezone ? `, timezone=${detectedTimezone}` : ''}) and ask "Does everything look correct?"
   - confirm -> confirm_onboarding_summary {confirmed:true}
   - edit -> ask field, confirm_onboarding_summary {confirmed:false, editField:<field>}, update field, re-summarize
9) "All set. Would you like me to show available therapists now?"
   - yes -> complete_onboarding {nextAction:"show_available_therapists"}
   - no -> complete_onboarding {nextAction:"end_for_now"}
`;

exports.createVoiceSession = catchAsync(async (req, res, next) => {
  if (!process.env.OPENAI_API_KEY) {
    return next(new AppError('OPENAI_API_KEY is not configured.', 500));
  }

  const {
    model = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-mini-realtime-preview',
    voice = 'alloy',
    firstName: firstNameFromBody,
    instructions: customInstructions,
    appLanguage = 'English',
    detectedTimezone,
  } = req.body || {};
  const firstName = req.user?.name || firstNameFromBody || 'there';
  const instructions =
    customInstructions ||
    buildOnboardingInstructions({ firstName, appLanguage, detectedTimezone });

  const openAIResponse = await fetch(
    'https://api.openai.com/v1/realtime/sessions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        voice,
        instructions,
        tools: onboardingTools,
        tool_choice: 'auto',
      }),
    },
  );

  const payload = await openAIResponse.json();

  if (!openAIResponse.ok) {
    return next(
      new AppError(
        payload?.error?.message || 'Failed to create OpenAI realtime session.',
        openAIResponse.status,
      ),
    );
  }

  res.status(200).json({
    status: 'success',
    client_secret: payload.client_secret,
    session: payload,
  });
});
