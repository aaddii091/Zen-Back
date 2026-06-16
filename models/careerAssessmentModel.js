const mongoose = require('mongoose');

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
    },
    report: {
      interestProfile: String,
      careerClusters: [String],
      readinessSnapshot: String,
      nextSteps: [String],
      generatedAt: Date,
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
