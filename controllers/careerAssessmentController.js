const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const CareerAssessment = require('../models/careerAssessmentModel');
const User = require('../models/userModel');
const TherapistProfile = require('../models/therapistProfileModel');

const RIASEC_LETTERS = {
  realistic: 'R',
  investigative: 'I',
  artistic: 'A',
  social: 'S',
  enterprising: 'E',
  conventional: 'C',
};

const clamp100 = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
const asArr = (x) => (Array.isArray(x) ? x : []);
const asStr = (x) => (typeof x === 'string' ? x.trim() : '');

// Shape, clamp and back-fill whatever the AI returns so the rich UI never breaks.
const normalizeReport = (raw) => {
  const r = raw && typeof raw === 'object' ? raw : {};

  // ── RIASEC (0-100 each) + derived topCodes ──
  const ri = r.riasec && typeof r.riasec === 'object' ? r.riasec : {};
  const riasec = {
    realistic: clamp100(ri.realistic),
    investigative: clamp100(ri.investigative),
    artistic: clamp100(ri.artistic),
    social: clamp100(ri.social),
    enterprising: clamp100(ri.enterprising),
    conventional: clamp100(ri.conventional),
  };
  let topCodes = asArr(ri.topCodes).map(asStr).filter(Boolean).slice(0, 3);
  if (topCodes.length < 3) {
    topCodes = Object.keys(RIASEC_LETTERS)
      .sort((a, b) => riasec[b] - riasec[a])
      .slice(0, 3)
      .map((k) => RIASEC_LETTERS[k]);
  }
  riasec.topCodes = topCodes;
  riasec.narrative = asStr(ri.narrative);

  const careerMatches = asArr(r.careerMatches)
    .map((m) => ({
      title: asStr(m && m.title),
      fitScore: clamp100(m && m.fitScore),
      description: asStr(m && m.description),
      exampleRoles: asArr(m && m.exampleRoles).map(asStr).filter(Boolean),
      whyItFits: asStr(m && m.whyItFits),
    }))
    .filter((m) => m.title)
    .sort((a, b) => b.fitScore - a.fitScore);

  const values = asArr(r.values)
    .map((v) => ({ label: asStr(v && v.label), weight: clamp100(v && v.weight) }))
    .filter((v) => v.label)
    .sort((a, b) => b.weight - a.weight);

  const skills = asArr(r.skills)
    .map((s) => ({ label: asStr(s && s.label), score: clamp100(s && s.score) }))
    .filter((s) => s.label)
    .sort((a, b) => b.score - a.score);

  const rd = r.readiness && typeof r.readiness === 'object' ? r.readiness : {};
  const academic = clamp100(rd.academic);
  const financial = clamp100(rd.financial);
  const clarity = clamp100(rd.clarity);
  let overall = clamp100(rd.overall);
  if (!overall && (academic || financial || clarity)) {
    overall = Math.round((academic + financial + clarity) / 3);
  }
  const readiness = { overall, academic, financial, clarity, narrative: asStr(rd.narrative) };

  const educationPathways = asArr(r.educationPathways)
    .map((p) => ({
      title: asStr(p && p.title),
      description: asStr(p && p.description),
      typicalDuration: asStr(p && p.typicalDuration),
      exams: asArr(p && p.exams).map(asStr).filter(Boolean),
      courses: asArr(p && p.courses).map(asStr).filter(Boolean),
      note: asStr(p && p.note),
    }))
    .filter((p) => p.title);

  const roadmap = asArr(r.roadmap)
    .map((m) => ({
      timeframe: asStr(m && m.timeframe),
      title: asStr(m && m.title),
      actions: asArr(m && m.actions).map(asStr).filter(Boolean),
    }))
    .filter((m) => m.title || m.timeframe);

  const strengths = asArr(r.strengths).map(asStr).filter(Boolean);
  const fieldsToExplore = asArr(r.fieldsToExplore).map(asStr).filter(Boolean);
  const challenges = asArr(r.challenges)
    .map((c) => ({ concern: asStr(c && c.concern), suggestion: asStr(c && c.suggestion) }))
    .filter((c) => c.concern || c.suggestion);

  const archetype = {
    title: asStr(r.archetype && r.archetype.title),
    summary: asStr(r.archetype && r.archetype.summary),
  };

  // ── legacy mirrors (keep old consumers + counselor admin list working) ──
  const legacyClusters = asArr(r.careerClusters).map(asStr).filter(Boolean);
  const legacyNext = asArr(r.nextSteps).map(asStr).filter(Boolean);

  return {
    version: 2,
    generatedAt: new Date(),
    archetype,
    riasec,
    careerMatches,
    values,
    skills,
    readiness,
    educationPathways,
    roadmap,
    strengths,
    challenges,
    fieldsToExplore,
    interestProfile: asStr(r.interestProfile) || archetype.summary || riasec.narrative,
    careerClusters: legacyClusters.length ? legacyClusters : careerMatches.map((m) => m.title).slice(0, 5),
    readinessSnapshot: asStr(r.readinessSnapshot) || readiness.narrative,
    nextSteps: legacyNext.length ? legacyNext : ((roadmap[0] && roadmap[0].actions) || []).slice(0, 4),
  };
};

const generateReportWithAI = async ({ phase1, phase2 }) => {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured');
  }

  const skills = phase2.skillsRatings || {};
  const skillsLine = [
    `Communication: ${skills.communication != null ? skills.communication : '–'}/5`,
    `Problem-solving: ${skills.problemSolving != null ? skills.problemSolving : '–'}/5`,
    `Creativity: ${skills.creativity != null ? skills.creativity : '–'}/5`,
    `Leadership: ${skills.leadership != null ? skills.leadership : '–'}/5`,
    `Technical/Computers: ${skills.technical != null ? skills.technical : '–'}/5`,
    `Working with numbers: ${skills.numeracy != null ? skills.numeracy : '–'}/5`,
  ].join(', ');

  const systemPrompt = `You are an expert career counselor for Indian school and college students (classes 10-12 and undergraduates). Write in warm, encouraging, jargon-free language that a 16-year-old easily understands. Be realistic and honest, but never discouraging. Use the Indian education and careers context throughout: streams (Science/Commerce/Arts), Indian entrance exams (JEE, NEET, CLAT, CUET, NDA, CA/CS, NIFT, NATA, etc.), Indian degree paths and rupee (₹) budgets.

You MUST return ONLY a valid JSON object matching the schema the user provides. Data rules:
- ALL numeric fields are integers from 0 to 100.
- riasec: score all six dimensions (realistic, investigative, artistic, social, enterprising, conventional). Spread the scores to reflect real relative strength — do NOT make them all equal. topCodes = the three highest dimensions as single letters from R, I, A, S, E, C.
- careerMatches: 4 to 6 entries sorted by fitScore descending; the top match should be 70-95. Each needs a simple description, 2-4 exampleRoles, and a one-line whyItFits.
- values and skills: 5-6 items each, sorted descending by weight/score. Ground skills in the student's self-ratings.
- readiness.overall should roughly reflect the academic, financial and clarity sub-scores.
- educationPathways: 3-4 India-aware paths (relevant entrance exams + realistic courses for the student's budget and location).
- roadmap: 4-5 milestones with timeframes like "Next 3 months", "6-12 months", "1-2 years", "3-5 years"; each with 2-4 concrete actions.
- strengths: 4-6 short phrases. challenges: 2-3 items (concern + practical suggestion). fieldsToExplore: 4-6 specific fields/careers.`;

  const userPrompt = `Student Profile:

Phase 1 - Interests & You:
- Interests: ${(phase1.interests || []).join(', ') || 'Not specified'}
- Favourite school subjects: ${(phase1.favouriteSubjects || []).join(', ') || 'Not specified'}
- Preferred work environment: ${phase1.workEnvironment || 'Not specified'}
- Task types enjoyed: ${(phase1.taskTypes || []).join(', ') || 'Not specified'}
- Work preference: ${phase1.workPreference || 'Not specified'}
- People preference: ${phase1.peoplePreference || 'Not specified'}
- Careers they are curious about: ${phase1.curiousCareers || 'Not specified'}
- Career role models they admire: ${phase1.roleModels || 'Not specified'}
- Biggest worry about future: ${phase1.biggestWorry || 'Not specified'}

Phase 2 - Background, Skills & Goals:
- Education level: ${phase2.educationLevel || 'Not specified'}
- Stream / major: ${phase2.stream || 'Not specified'}
- Academic performance: ${phase2.academicPerformance || 'Not specified'}
- Budget for further studies: ${phase2.studyBudget || 'Not specified'}
- Location preference: ${phase2.locationPreference || 'Not specified'}
- Timeline for next step: ${phase2.timeline || 'Not specified'}
- What matters most in career: ${(phase2.careerValues || []).join(', ') || 'Not specified'}
- Self-rated skills (1-5): ${skillsLine}
- Openness to entrepreneurship: ${phase2.entrepreneurshipOpenness || 'Not specified'}
- Short-term goal (1-2 years): ${phase2.shortTermGoal || 'Not specified'}
- Long-term goal (5-10 years): ${phase2.longTermGoal || 'Not specified'}
- Constraints or concerns: ${(phase2.constraints || []).join(', ') || 'Not specified'}

Return ONLY a JSON object with EXACTLY this structure:
{
  "archetype": { "title": "Short inspiring 2-4 word persona e.g. 'The Analytical Creator'", "summary": "2-3 sentences on who they are and how they work." },
  "riasec": {
    "realistic": 0, "investigative": 0, "artistic": 0, "social": 0, "enterprising": 0, "conventional": 0,
    "topCodes": ["I", "A", "S"],
    "narrative": "2-3 sentences explaining their interest code in plain language."
  },
  "careerMatches": [
    { "title": "Career field", "fitScore": 0, "description": "What this field is, simply.", "exampleRoles": ["Role 1", "Role 2"], "whyItFits": "Why it suits this student." }
  ],
  "values": [ { "label": "Value name", "weight": 0 } ],
  "skills": [ { "label": "Skill name", "score": 0 } ],
  "readiness": { "overall": 0, "academic": 0, "financial": 0, "clarity": 0, "narrative": "Honest 2-3 sentence reality check." },
  "educationPathways": [
    { "title": "Pathway name", "description": "What it involves.", "typicalDuration": "e.g. 3-4 years", "exams": ["Exam"], "courses": ["Course"], "note": "Budget/location-aware tip." }
  ],
  "roadmap": [ { "timeframe": "Next 3 months", "title": "Milestone", "actions": ["Action 1", "Action 2"] } ],
  "strengths": ["Strength 1", "Strength 2"],
  "challenges": [ { "concern": "A real concern.", "suggestion": "How to handle it." } ],
  "fieldsToExplore": ["Field 1", "Field 2"]
}`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.7,
      max_tokens: 3500,
      response_format: { type: 'json_object' },
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || 'AI report generation failed');
  }

  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty response from AI');

  return JSON.parse(content);
};

exports.startOrGetAssessment = catchAsync(async (req, res) => {
  const assessment = await CareerAssessment.findOneAndUpdate(
    { user: req.user._id },
    { $setOnInsert: { user: req.user._id } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  res.status(200).json({
    status: 'success',
    data: assessment,
  });
});

exports.savePhase1 = catchAsync(async (req, res, next) => {
  const {
    interests,
    workEnvironment,
    taskTypes,
    curiousCareers,
    biggestWorry,
    favouriteSubjects,
    workPreference,
    peoplePreference,
    roleModels,
  } = req.body;

  const assessment = await CareerAssessment.findOneAndUpdate(
    { user: req.user._id },
    {
      phase1: {
        interests,
        workEnvironment,
        taskTypes,
        curiousCareers,
        biggestWorry,
        favouriteSubjects,
        workPreference,
        peoplePreference,
        roleModels,
      },
      status: 'phase1_complete',
    },
    { new: true, upsert: true },
  );

  if (!assessment) return next(new AppError('Assessment not found', 404));

  res.status(200).json({
    status: 'success',
    data: assessment,
  });
});

exports.savePhase2 = catchAsync(async (req, res, next) => {
  const {
    educationLevel,
    stream,
    academicPerformance,
    studyBudget,
    locationPreference,
    timeline,
    careerValues,
    shortTermGoal,
    longTermGoal,
    constraints,
    skillsRatings,
    entrepreneurshipOpenness,
  } = req.body;

  const phase2 = {
    educationLevel,
    stream,
    academicPerformance,
    studyBudget,
    locationPreference,
    timeline,
    careerValues,
    shortTermGoal,
    longTermGoal,
    constraints,
    skillsRatings,
    entrepreneurshipOpenness,
  };

  let assessment = await CareerAssessment.findOneAndUpdate(
    { user: req.user._id },
    { phase2, status: 'phase2_complete' },
    { new: true, upsert: true },
  );

  if (!assessment) return next(new AppError('Assessment not found', 404));

  try {
    const reportData = await generateReportWithAI({
      phase1: assessment.phase1 || {},
      phase2,
    });

    assessment = await CareerAssessment.findOneAndUpdate(
      { user: req.user._id },
      {
        report: normalizeReport(reportData),
        status: 'report_ready',
      },
      { new: true },
    );
  } catch (err) {
    console.error('AI report generation error:', err.message);
  }

  res.status(200).json({
    status: 'success',
    data: assessment,
  });
});

exports.getMyReport = catchAsync(async (req, res, next) => {
  const assessment = await CareerAssessment.findOne({ user: req.user._id });
  if (!assessment) return next(new AppError('No assessment found for this user', 404));

  res.status(200).json({
    status: 'success',
    data: assessment,
  });
});

exports.bookSession = catchAsync(async (req, res, next) => {
  const assessment = await CareerAssessment.findOneAndUpdate(
    { user: req.user._id },
    { sessionBooked: true, status: 'session_booked' },
    { new: true },
  );

  if (!assessment) return next(new AppError('Assessment not found', 404));

  res.status(200).json({
    status: 'success',
    data: assessment,
  });
});

exports.getMyCounselor = catchAsync(async (req, res, next) => {
  const user = await User.findById(req.user._id).select('assignedCareerCounselor');
  if (!user?.assignedCareerCounselor) {
    return res.status(200).json({ status: 'success', data: null });
  }

  const profile = await TherapistProfile.findOne({ user: user.assignedCareerCounselor }).lean();
  if (!profile) return res.status(200).json({ status: 'success', data: null });

  const counselorUser = await User.findById(user.assignedCareerCounselor).select('name email').lean();

  const photoUrl = (() => {
    const d = profile?.photo?.data;
    const ct = profile?.photo?.contentType;
    if (!d || !ct) return '';
    return `data:${ct};base64,${Buffer.from(d).toString('base64')}`;
  })();

  res.status(200).json({
    status: 'success',
    data: {
      counselorUserId: String(user.assignedCareerCounselor),
      displayName: profile.displayName || counselorUser?.name || 'Career Counselor',
      title: profile.title || 'Career Counselor',
      bio: profile.bio || '',
      specializations: profile.specializations || [],
      languages: profile.languages || [],
      sessionModes: profile.sessionModes || [],
      calendlyUrl: profile.calendlyUrl || '',
      availabilityStatus: profile.availabilityStatus || '',
      photoUrl,
    },
  });
});

exports.assignCounselor = catchAsync(async (req, res, next) => {
  const { userId } = req.params;
  const counselorId = req.user._id;

  const targetUser = await User.findById(userId);
  if (!targetUser) return next(new AppError('User not found', 404));

  targetUser.assignedCareerCounselor = counselorId;
  await targetUser.save({ validateBeforeSave: false });

  res.status(200).json({
    status: 'success',
    message: 'Career counselor assigned successfully',
  });
});

exports.getAllAssessments = catchAsync(async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const skip = (page - 1) * limit;

  const assessments = await CareerAssessment.find()
    .populate('user', 'name email')
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit);

  const total = await CareerAssessment.countDocuments();

  res.status(200).json({
    status: 'success',
    total,
    page,
    data: assessments,
  });
});
