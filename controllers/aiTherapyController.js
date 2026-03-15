const mongoose = require('mongoose');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const AiTherapySession = require('../models/aiTherapySessionModel');
const { createTherapyRealtimeSession } = require('../AIAgents/therapySession');

const DEFAULT_REPORT_MODEL = process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini';

const ALLOWED_PHASES = new Set([
  'check_in',
  'goal',
  'trigger_map',
  'reframe',
  'action_plan',
  'safety',
  'close',
]);

const normalizeString = (value, max = 1200) =>
  String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

const toNumberOrNull = (value, { min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY } = {}) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(min, Math.min(max, parsed));
};

const asDate = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const toDurationSec = (startedAt, endedAt) => {
  const startTs = startedAt ? new Date(startedAt).getTime() : Date.now();
  const endTs = endedAt ? new Date(endedAt).getTime() : Date.now();
  return Math.max(0, Math.round((endTs - startTs) / 1000));
};

const ensureAuthedUser = (req, { requireOnboarded = false } = {}) => {
  if (!req.user) {
    throw new AppError('You are not logged in. Please log in to get access.', 401);
  }
  if (req.user.role !== 'user') {
    throw new AppError('Only users can access AI therapy.', 403);
  }
  if (requireOnboarded && !req.user.hasOnboarded) {
    throw new AppError('Please complete onboarding before starting AI therapy.', 403);
  }
};

const normalizePhaseState = (input = {}) => {
  const checkIn = input?.checkIn || {};
  const sessionGoal = input?.sessionGoal || {};
  const triggerMap = input?.triggerMap || {};
  const reframe = input?.reframe || {};
  const actionPlan = input?.actionPlan || {};
  const completion = input?.completion || {};

  return {
    checkIn: {
      moodScore: toNumberOrNull(checkIn.moodScore, { min: 0, max: 10 }),
      currentEmotions: Array.isArray(checkIn.currentEmotions)
        ? checkIn.currentEmotions
            .map((emotion) => normalizeString(emotion, 60))
            .filter(Boolean)
            .slice(0, 10)
        : [],
      context: normalizeString(checkIn.context, 1600),
    },
    sessionGoal: {
      goal: normalizeString(sessionGoal.goal, 1600),
    },
    triggerMap: {
      situation: normalizeString(triggerMap.situation, 1600),
      automaticThought: normalizeString(triggerMap.automaticThought, 1600),
      bodySignal: normalizeString(triggerMap.bodySignal, 1600),
      behaviorLoop: normalizeString(triggerMap.behaviorLoop, 1600),
    },
    reframe: {
      balancedThought: normalizeString(reframe.balancedThought, 1600),
      evidenceFor: normalizeString(reframe.evidenceFor, 1600),
      evidenceAgainst: normalizeString(reframe.evidenceAgainst, 1600),
    },
    actionPlan: {
      step24h: normalizeString(actionPlan.step24h, 1600),
      step7d: normalizeString(actionPlan.step7d, 1600),
      frictionBlocker: normalizeString(actionPlan.frictionBlocker, 1600),
      copingStrategy: normalizeString(actionPlan.copingStrategy, 1600),
    },
    completion: {
      summarySignal: normalizeString(completion.summarySignal, 1600),
      confidenceScore: toNumberOrNull(completion.confidenceScore, {
        min: 0,
        max: 10,
      }),
    },
  };
};

const normalizeRiskLevel = (value) => {
  const normalized = String(value || 'none').toLowerCase().trim();
  if (normalized === 'low' || normalized === 'high' || normalized === 'imminent') {
    return normalized;
  }
  return 'none';
};

const normalizeSafety = (input = {}) => {
  const riskLevel = normalizeRiskLevel(input.riskLevel);
  return {
    riskLevel,
    escalated: Boolean(input.escalated) || riskLevel === 'high' || riskLevel === 'imminent',
    reason: normalizeString(input.reason, 1200),
    resourcesShown: Array.isArray(input.resourcesShown)
      ? input.resourcesShown
          .map((value) => normalizeString(value, 120))
          .filter(Boolean)
          .slice(0, 10)
      : [],
  };
};

const normalizeKeyMoments = (input = []) => {
  if (!Array.isArray(input)) return [];

  return input
    .map((entry) => {
      const phaseRaw = normalizeString(entry?.phase, 40).toLowerCase();
      const phase = ALLOWED_PHASES.has(phaseRaw) ? phaseRaw : null;
      const label = normalizeString(entry?.label, 120);
      const note = normalizeString(entry?.note, 2000);
      const capturedAt = asDate(entry?.capturedAt) || new Date();

      if (!phase || !label || !note) return null;
      return {
        phase,
        label,
        note,
        capturedAt,
      };
    })
    .filter(Boolean)
    .slice(0, 40);
};

const extractJsonObject = (content = '') => {
  const raw = String(content || '').trim();
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    const firstBrace = raw.indexOf('{');
    const lastBrace = raw.lastIndexOf('}');
    if (firstBrace < 0 || lastBrace <= firstBrace) return null;
    try {
      return JSON.parse(raw.slice(firstBrace, lastBrace + 1));
    } catch {
      return null;
    }
  }
};

const normalizeReport = (input = {}) => ({
  sessionSnapshot: normalizeString(input.sessionSnapshot, 2500),
  whatYouShared: normalizeString(input.whatYouShared, 2500),
  patternsNoticed: normalizeString(input.patternsNoticed, 2500),
  helpfulReframes: normalizeString(input.helpfulReframes, 2500),
  actionPlan24h: normalizeString(input.actionPlan24h, 2500),
  actionPlan7d: normalizeString(input.actionPlan7d, 2500),
  copingPlanWhenTriggered: normalizeString(input.copingPlanWhenTriggered, 2500),
  safetyNotes: normalizeString(input.safetyNotes, 2500),
  encouragementAndNextStep: normalizeString(input.encouragementAndNextStep, 2500),
});

const buildFallbackReport = ({ phaseState, safety, durationSec }) => {
  const emotions = phaseState?.checkIn?.currentEmotions?.length
    ? phaseState.checkIn.currentEmotions.join(', ')
    : 'a mix of emotions';
  const goal = phaseState?.sessionGoal?.goal || 'find practical emotional support';

  return normalizeReport({
    sessionSnapshot: `You completed a ${Math.max(1, Math.round(durationSec / 60))}-minute AI support session focused on ${goal}.`,
    whatYouShared:
      phaseState?.checkIn?.context ||
      `You described your current state as ${emotions} and worked through what felt most important today.`,
    patternsNoticed:
      phaseState?.triggerMap?.automaticThought ||
      'A recurring stress-response loop was identified between thoughts, body signals, and reactions.',
    helpfulReframes:
      phaseState?.reframe?.balancedThought ||
      'A more balanced perspective was identified to reduce emotional intensity in difficult moments.',
    actionPlan24h:
      phaseState?.actionPlan?.step24h ||
      'Take one small supportive action within 24 hours, such as a calming reset and a short reflection.',
    actionPlan7d:
      phaseState?.actionPlan?.step7d ||
      'Repeat your key coping strategy consistently this week and note what improves.',
    copingPlanWhenTriggered:
      phaseState?.actionPlan?.copingStrategy ||
      'Pause, breathe slowly, name what you are feeling, and choose one grounded next action.',
    safetyNotes:
      safety?.riskLevel === 'high' || safety?.riskLevel === 'imminent'
        ? 'Your session included elevated safety risk language. Please contact local emergency services or a trusted crisis line immediately if you feel in danger.'
        : 'No immediate crisis risk was flagged in this session. Continue using your coping plan and seek support when needed.',
    encouragementAndNextStep:
      'You made meaningful progress by reflecting clearly and choosing specific next steps. Revisit this report before your next session.',
  });
};

const generateReportWithOpenAI = async ({ phaseState, keyMoments, safety, durationSec }) => {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured');
  }

  const reportPrompt = {
    language: 'English',
    constraints: [
      'Simple user-friendly language',
      'No diagnosis claims',
      'No medication advice',
      'If riskLevel is high/imminent include explicit urgent safety guidance',
    ],
    sessionData: {
      durationSec,
      phaseState,
      keyMoments,
      safety,
    },
    outputSchema: {
      sessionSnapshot: 'string',
      whatYouShared: 'string',
      patternsNoticed: 'string',
      helpfulReframes: 'string',
      actionPlan24h: 'string',
      actionPlan7d: 'string',
      copingPlanWhenTriggered: 'string',
      safetyNotes: 'string',
      encouragementAndNextStep: 'string',
    },
  };

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: DEFAULT_REPORT_MODEL,
      temperature: 0.4,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You are Zen report writer. Produce only a valid JSON object with the exact keys requested. Be concise, warm, practical, and non-clinical.',
        },
        {
          role: 'user',
          content: JSON.stringify(reportPrompt),
        },
      ],
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error?.message || 'Failed to generate therapy report');
  }

  const content = payload?.choices?.[0]?.message?.content;
  const parsed = extractJsonObject(content);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Therapy report response was not valid JSON.');
  }

  return {
    report: normalizeReport(parsed),
    model: payload?.model || DEFAULT_REPORT_MODEL,
  };
};

const parsePage = (value) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return parsed;
};

const parseLimit = (value) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 10;
  return Math.min(parsed, 50);
};

const ensureSessionOwnership = async (sessionId, userId) => {
  if (!mongoose.Types.ObjectId.isValid(sessionId)) {
    throw new AppError('Invalid session id.', 400);
  }

  const session = await AiTherapySession.findOne({ _id: sessionId, user: userId });
  if (!session) {
    throw new AppError('AI therapy session not found.', 404);
  }

  return session;
};

exports.createTherapyVoiceSession = catchAsync(async (req, res) => {
  ensureAuthedUser(req, { requireOnboarded: true });

  const { payload, meta } = await createTherapyRealtimeSession({
    firstName: req.user.name,
    model: req.body?.model,
    voice: req.body?.voice,
  });

  const startedAt = new Date();
  const session = await AiTherapySession.create({
    user: req.user._id,
    status: 'active',
    startedAt,
    engine: meta,
    reportMeta: {
      generationStatus: 'pending',
    },
    visibility: 'user_only',
  });

  res.status(200).json({
    status: 'success',
    data: {
      sessionId: session._id,
      startedAt: session.startedAt,
      engine: session.engine,
      client_secret: payload?.client_secret,
      session: payload,
    },
  });
});

exports.finalizeTherapySession = catchAsync(async (req, res) => {
  ensureAuthedUser(req);

  const session = await ensureSessionOwnership(req.params.id, req.user._id);

  if (session.status === 'completed' || session.status === 'aborted' || session.status === 'safety_paused') {
    return res.status(200).json({
      status: 'success',
      data: {
        sessionId: session._id,
        reportId: session._id,
        report: session.report,
        reportMeta: session.reportMeta,
      },
    });
  }

  const endedAt = asDate(req.body?.endedAt) || new Date();
  const phaseState = normalizePhaseState(req.body?.phaseState || {});
  const keyMoments = normalizeKeyMoments(req.body?.keyMoments || []);
  const safety = normalizeSafety(req.body?.safety || {});
  const requestedStatus = String(req.body?.status || 'completed').toLowerCase();

  const durationSec = toDurationSec(session.startedAt, endedAt);

  let report;
  let reportModel = DEFAULT_REPORT_MODEL;
  let generationStatus = 'success';

  try {
    const generated = await generateReportWithOpenAI({
      phaseState,
      keyMoments,
      safety,
      durationSec,
    });
    report = generated.report;
    reportModel = generated.model;
  } catch (error) {
    report = buildFallbackReport({ phaseState, safety, durationSec });
    generationStatus = 'fallback';
  }

  let status = 'completed';
  if (requestedStatus === 'aborted') {
    status = 'aborted';
  } else if (safety.riskLevel === 'high' || safety.riskLevel === 'imminent') {
    status = 'safety_paused';
  }

  session.phaseState = phaseState;
  session.keyMoments = keyMoments;
  session.safety = safety;
  session.status = status;
  session.endedAt = endedAt;
  session.durationSec = durationSec;
  session.report = report;
  session.reportMeta = {
    generatedAt: new Date(),
    generationModel: reportModel,
    generationStatus,
  };

  await session.save();

  res.status(200).json({
    status: 'success',
    data: {
      sessionId: session._id,
      reportId: session._id,
      status: session.status,
      endedAt: session.endedAt,
      durationSec: session.durationSec,
      report: session.report,
      reportMeta: session.reportMeta,
    },
  });
});

exports.abortTherapySession = catchAsync(async (req, res) => {
  ensureAuthedUser(req);

  const session = await ensureSessionOwnership(req.params.id, req.user._id);

  if (session.status === 'completed' || session.status === 'aborted' || session.status === 'safety_paused') {
    return res.status(200).json({
      status: 'success',
      data: {
        sessionId: session._id,
        status: session.status,
        endedAt: session.endedAt,
        durationSec: session.durationSec,
      },
    });
  }

  const endedAt = new Date();
  const durationSec = toDurationSec(session.startedAt, endedAt);
  const reason = normalizeString(req.body?.reason, 500);

  session.status = 'aborted';
  session.endedAt = endedAt;
  session.durationSec = durationSec;

  if (reason) {
    session.keyMoments.push({
      phase: 'close',
      label: 'Session ended early',
      note: reason,
      capturedAt: endedAt,
    });
  }

  await session.save();

  res.status(200).json({
    status: 'success',
    data: {
      sessionId: session._id,
      status: session.status,
      endedAt: session.endedAt,
      durationSec: session.durationSec,
    },
  });
});

exports.getMyTherapyReports = catchAsync(async (req, res) => {
  ensureAuthedUser(req);

  const page = parsePage(req.query?.page);
  const limit = parseLimit(req.query?.limit);
  const skip = (page - 1) * limit;

  const filter = {
    user: req.user._id,
    visibility: 'user_only',
    reportMeta: { $exists: true },
    'reportMeta.generatedAt': { $ne: null },
  };

  const [items, total] = await Promise.all([
    AiTherapySession.find(filter)
      .sort({ endedAt: -1, startedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    AiTherapySession.countDocuments(filter),
  ]);

  const data = items.map((item) => ({
    id: item._id,
    status: item.status,
    startedAt: item.startedAt || null,
    endedAt: item.endedAt || null,
    durationSec: Number(item.durationSec || 0),
    riskLevel: item?.safety?.riskLevel || 'none',
    title: normalizeString(item?.report?.sessionSnapshot || 'AI Therapy Session', 140),
    topFocus: normalizeString(
      item?.phaseState?.sessionGoal?.goal || item?.phaseState?.checkIn?.context || '',
      140,
    ),
    generatedAt: item?.reportMeta?.generatedAt || null,
  }));

  res.status(200).json({
    status: 'success',
    results: data.length,
    total,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 0,
    },
    data,
  });
});

exports.getMyTherapyReportById = catchAsync(async (req, res) => {
  ensureAuthedUser(req);

  const session = await ensureSessionOwnership(req.params.id, req.user._id);

  if (!session.reportMeta?.generatedAt) {
    throw new AppError('Report is not ready for this session yet.', 404);
  }

  res.status(200).json({
    status: 'success',
    data: {
      id: session._id,
      status: session.status,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      durationSec: session.durationSec,
      engine: session.engine,
      phaseState: session.phaseState,
      safety: session.safety,
      keyMoments: session.keyMoments,
      report: session.report,
      reportMeta: session.reportMeta,
      visibility: session.visibility,
    },
  });
});
