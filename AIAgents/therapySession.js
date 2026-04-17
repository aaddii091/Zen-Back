const AppError = require('../utils/appError');

const THERAPY_FLOW_VERSION = 'therapy-flow-v1';
const DEFAULT_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-mini-realtime-preview';
const DEFAULT_VOICE = process.env.OPENAI_REALTIME_VOICE || 'alloy';

const therapyTools = [
  {
    type: 'function',
    name: 'set_check_in',
    parameters: {
      type: 'object',
      properties: {
        moodScore: { type: 'number' },
        currentEmotions: {
          type: 'array',
          items: { type: 'string' },
        },
        context: { type: 'string' },
      },
      required: ['moodScore', 'currentEmotions', 'context'],
    },
  },
  {
    type: 'function',
    name: 'set_session_goal',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string' },
      },
      required: ['goal'],
    },
  },
  {
    type: 'function',
    name: 'set_trigger_map',
    parameters: {
      type: 'object',
      properties: {
        situation: { type: 'string' },
        automaticThought: { type: 'string' },
        bodySignal: { type: 'string' },
        behaviorLoop: { type: 'string' },
      },
      required: ['situation', 'automaticThought', 'bodySignal', 'behaviorLoop'],
    },
  },
  {
    type: 'function',
    name: 'set_reframe',
    parameters: {
      type: 'object',
      properties: {
        balancedThought: { type: 'string' },
        evidenceFor: { type: 'string' },
        evidenceAgainst: { type: 'string' },
      },
      required: ['balancedThought', 'evidenceFor', 'evidenceAgainst'],
    },
  },
  {
    type: 'function',
    name: 'set_action_plan',
    parameters: {
      type: 'object',
      properties: {
        step24h: { type: 'string' },
        step7d: { type: 'string' },
        frictionBlocker: { type: 'string' },
        copingStrategy: { type: 'string' },
      },
      required: ['step24h', 'step7d', 'frictionBlocker', 'copingStrategy'],
    },
  },
  {
    type: 'function',
    name: 'set_safety_status',
    parameters: {
      type: 'object',
      properties: {
        riskLevel: {
          type: 'string',
          enum: ['none', 'low', 'high', 'imminent'],
        },
        reason: { type: 'string' },
      },
      required: ['riskLevel', 'reason'],
    },
  },
  {
    type: 'function',
    name: 'complete_therapy_session',
    parameters: {
      type: 'object',
      properties: {
        summarySignal: { type: 'string' },
        confidenceScore: { type: 'number' },
      },
      required: ['summarySignal', 'confidenceScore'],
    },
  },
];

const buildTherapyInstructions = ({ firstName = 'there' } = {}) => `
You are Zen, a supportive AI therapy assistant for one-on-one voice sessions.
Style rules:
- Use warm CBT + motivational interviewing.
- Ask one primary question at a time.
- Keep acknowledgements short and natural.
- Ask at most one clarification follow-up before moving forward.
- Never dump a checklist all at once.
- You are not a licensed therapist. Do not diagnose and do not provide medication advice.
- Do not assume user answers from silence, noise, or unclear audio.
- Only call a tool after the user has provided an explicit answer in that turn.
- If audio is unclear or user is silent, ask: "I didn't catch that clearly. Could you repeat?" and wait.
- If the user says "I don't know", "skip", or gives no answer, keep the same phase and ask one gentle rephrase instead of progressing.

Safety protocol:
- If user expresses self-harm, suicide, or immediate danger, immediately switch to safety mode.
- Call set_safety_status with riskLevel high or imminent and a short reason.
- Pause normal phase progression and give urgent safety guidance.

Session structure (fixed order):
1) Check-in: mood + emotions + context -> set_check_in
2) Goal for this session -> set_session_goal
3) Trigger map (situation, thought, body, behavior) -> set_trigger_map
4) Reframe (balanced thought + evidence) -> set_reframe
5) Action plan (24h step, 7d step, friction blocker, coping strategy) -> set_action_plan
6) Close with concise recap and confidence -> complete_therapy_session

Start with:
"Hi ${firstName}, I am Zen. We can move step by step today. On a scale of 0 to 10, how are you feeling right now?"
`; 

const createTherapyRealtimeSession = async ({
  firstName,
  model = DEFAULT_MODEL,
  voice = DEFAULT_VOICE,
} = {}) => {
  if (!process.env.OPENAI_API_KEY) {
    throw new AppError('OPENAI_API_KEY is not configured.', 500);
  }

  const instructions = buildTherapyInstructions({ firstName });

  const response = await fetch('https://api.openai.com/v1/realtime/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      voice,
      instructions,
      tools: therapyTools,
      tool_choice: 'auto',
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new AppError(
      payload?.error?.message || 'Failed to create therapy realtime session.',
      response.status || 500,
    );
  }

  return {
    payload,
    meta: {
      provider: 'openai',
      model,
      voice,
      flowVersion: THERAPY_FLOW_VERSION,
    },
  };
};

module.exports = {
  THERAPY_FLOW_VERSION,
  therapyTools,
  buildTherapyInstructions,
  createTherapyRealtimeSession,
};
