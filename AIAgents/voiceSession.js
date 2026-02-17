const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');

exports.createVoiceSession = catchAsync(async (req, res, next) => {
  if (!process.env.OPENAI_API_KEY) {
    return next(new AppError('OPENAI_API_KEY is not configured.', 500));
  }

  const {
    model = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview',
    voice = 'alloy',
    instructions = 'You are a helpful voice assistant.',
  } = req.body || {};

  const openAIResponse = await fetch('https://api.openai.com/v1/realtime/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      voice,
      instructions,
    }),
  });

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
