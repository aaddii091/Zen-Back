const mongoose = require('mongoose');

// ── report sub-schemas (no _id on chart data → clean payloads) ──────────────
const careerMatchSchema = new mongoose.Schema(
  {
    title: String,
    fitScore: { type: Number, default: 0 }, // 0-100
    description: String,
    exampleRoles: [String],
    whyItFits: String,
  },
  { _id: false },
);

const labeledScoreSchema = new mongoose.Schema(
  { label: String, weight: { type: Number, default: 0 } }, // values (0-100)
  { _id: false },
);

const labeledSkillSchema = new mongoose.Schema(
  { label: String, score: { type: Number, default: 0 } }, // skills (0-100)
  { _id: false },
);

const educationPathwaySchema = new mongoose.Schema(
  {
    title: String,
    description: String,
    typicalDuration: String,
    exams: [String],
    courses: [String],
    note: String,
  },
  { _id: false },
);

const roadmapMilestoneSchema = new mongoose.Schema(
  { timeframe: String, title: String, actions: [String] },
  { _id: false },
);

const challengeSchema = new mongoose.Schema(
  { concern: String, suggestion: String },
  { _id: false },
);

const careerAssessmentSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
    status: {
      type: String,
      enum: ['started', 'phase1_complete', 'phase2_complete', 'report_ready', 'session_booked'],
      default: 'started',
    },
    phase1: {
      interests: [String],
      workEnvironment: String,
      taskTypes: [String],
      curiousCareers: String,
      biggestWorry: String,
      // ── added for richer report ──
      favouriteSubjects: [String],
      workPreference: String,
      peoplePreference: String,
      roleModels: String,
    },
    phase2: {
      educationLevel: String,
      stream: String,
      academicPerformance: String,
      studyBudget: String,
      locationPreference: String,
      timeline: String,
      careerValues: [String],
      shortTermGoal: String,
      longTermGoal: String,
      constraints: [String],
      // ── added for richer report ──
      skillsRatings: {
        communication: Number,
        problemSolving: Number,
        creativity: Number,
        leadership: Number,
        technical: Number,
        numeracy: Number,
      },
      entrepreneurshipOpenness: String,
    },
    report: {
      version: { type: Number, default: 2 },
      generatedAt: Date,

      // hero / persona
      archetype: { title: String, summary: String },

      // RIASEC interest profile (hexagon radar) — each 0-100
      riasec: {
        realistic: { type: Number, default: 0 },
        investigative: { type: Number, default: 0 },
        artistic: { type: Number, default: 0 },
        social: { type: Number, default: 0 },
        enterprising: { type: Number, default: 0 },
        conventional: { type: Number, default: 0 },
        topCodes: [String],
        narrative: String,
      },

      careerMatches: [careerMatchSchema],
      values: [labeledScoreSchema],
      skills: [labeledSkillSchema],

      readiness: {
        overall: { type: Number, default: 0 },
        academic: { type: Number, default: 0 },
        financial: { type: Number, default: 0 },
        clarity: { type: Number, default: 0 },
        narrative: String,
      },

      educationPathways: [educationPathwaySchema],
      roadmap: [roadmapMilestoneSchema],
      strengths: [String],
      challenges: [challengeSchema],
      fieldsToExplore: [String],

      // ── legacy fields (kept for backward-compat; re-populated by normalizer) ──
      interestProfile: String,
      careerClusters: [String],
      readinessSnapshot: String,
      nextSteps: [String],
    },
    sessionBooked: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true },
);

const CareerAssessment = mongoose.model('CareerAssessment', careerAssessmentSchema);

module.exports = CareerAssessment;
