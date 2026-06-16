const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const CareerAssessment = require('../models/careerAssessmentModel');
const User = require('../models/userModel');

const generateReportWithAI = async ({ phase1, phase2 }) => {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured');
  }

  const prompt = `You are a career counselor assistant. Based on a student's assessment answers, generate a personalised career guidance report in JSON format.

Student Profile:
Phase 1 - Interests & Preferences:
- Interests: ${(phase1.interests || []).join(', ')}
- Preferred Work Environment: ${phase1.workEnvironment || 'Not specified'}
- Task Types Enjoyed: ${(phase1.taskTypes || []).join(', ')}
- Careers They Are Curious About: ${phase1.curiousCareers || 'Not specified'}
- Biggest Worry About Future: ${phase1.biggestWorry || 'Not specified'}

Phase 2 - Background & Aspirations:
- Education Level: ${phase2.educationLevel || 'Not specified'}
- Stream / Major: ${phase2.stream || 'Not specified'}
- Academic Performance: ${phase2.academicPerformance || 'Not specified'}
- Budget for Further Studies: ${phase2.studyBudget || 'Not specified'}
- Location Preference: ${phase2.locationPreference || 'Not specified'}
- Timeline for Next Step: ${phase2.timeline || 'Not specified'}
- What Matters Most in Career: ${(phase2.careerValues || []).join(', ')}
- Short-term Goal (1-2 years): ${phase2.shortTermGoal || 'Not specified'}
- Long-term Goal (5-10 years): ${phase2.longTermGoal || 'Not specified'}
- Constraints or Concerns: ${(phase2.constraints || []).join(', ')}

Return ONLY a valid JSON object with this exact structure:
{
  "interestProfile": "A 2-3 sentence personalised summary of the student's interest and work style profile.",
  "careerClusters": ["Domain 1", "Domain 2", "Domain 3", "Domain 4"],
  "readinessSnapshot": "A 2-3 sentence honest assessment of where the student stands right now and what they should be aware of.",
  "nextSteps": ["Actionable step 1", "Actionable step 2", "Actionable step 3"]
}

careerClusters should be 3-5 specific career domains that match the student's interests and background.
nextSteps should be concrete, personalised actions the student can take in the next 1-3 months.`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
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
  const { interests, workEnvironment, taskTypes, curiousCareers, biggestWorry } = req.body;

  const assessment = await CareerAssessment.findOneAndUpdate(
    { user: req.user._id },
    {
      phase1: { interests, workEnvironment, taskTypes, curiousCareers, biggestWorry },
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
        report: {
          interestProfile: reportData.interestProfile,
          careerClusters: reportData.careerClusters,
          readinessSnapshot: reportData.readinessSnapshot,
          nextSteps: reportData.nextSteps,
          generatedAt: new Date(),
        },
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
