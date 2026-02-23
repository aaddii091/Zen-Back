const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');

const DEFAULT_MODEL = process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini';

const SYSTEM_PROMPT = `You are Zen, a supportive AI mental wellness assistant for therapy users.
Your role:
- Be empathetic, calm, and practical.
- Help users reflect, regulate emotions, and plan healthy next steps.
- Do not claim to be a licensed therapist or provide diagnosis.
- Do not provide medication advice.
- If the user mentions self-harm, suicide, or immediate danger, respond with urgent safety guidance and encourage contacting local emergency services/crisis lines immediately.
- Keep answers concise, warm, and clear.
- When useful, suggest breathing, grounding, journaling, reframing, and reaching out to trusted support.
`;

const normalizeMessages = (messages = []) => {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((item) => item && typeof item.role === 'string' && typeof item.content === 'string')
    .map((item) => ({
      role: item.role === 'assistant' ? 'assistant' : 'user',
      content: item.content.trim(),
    }))
    .filter((item) => item.content.length > 0)
    .slice(-12);
};

exports.chat = catchAsync(async (req, res, next) => {
  if (!process.env.OPENAI_API_KEY) {
    return next(new AppError('OPENAI_API_KEY is not configured.', 500));
  }

  const { message = '', messages = [] } = req.body || {};
  const userMessage = String(message || '').trim();

  if (!userMessage) {
    return next(new AppError('message is required', 400));
  }

  const history = normalizeMessages(messages);

  const openAIResponse = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      temperature: 0.6,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...history,
        { role: 'user', content: userMessage },
      ],
    }),
  });

  const payload = await openAIResponse.json().catch(() => ({}));

  if (!openAIResponse.ok) {
    return next(
      new AppError(
        payload?.error?.message || 'Failed to generate AI assistant response.',
        openAIResponse.status || 500,
      ),
    );
  }

  const reply =
    payload?.choices?.[0]?.message?.content?.trim() ||
    'I am here with you. Could you share a bit more so I can help better?';

  res.status(200).json({
    status: 'success',
    data: {
      reply,
      model: payload?.model || DEFAULT_MODEL,
    },
  });
});
