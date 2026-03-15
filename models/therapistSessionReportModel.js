const mongoose = require('mongoose');

const therapistSessionReportSchema = new mongoose.Schema(
  {
    therapist: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Therapist is required.'],
      index: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Client user is required.'],
      index: true,
    },
    appointmentRef: {
      type: String,
      trim: true,
      default: '',
      index: true,
    },
    sessionAt: {
      type: Date,
      default: null,
      index: true,
    },
    sessionAtBucket: {
      type: Date,
      default: null,
      index: true,
    },
    status: {
      type: String,
      enum: ['draft', 'submitted'],
      default: 'draft',
      index: true,
    },
    subjective: {
      type: String,
      trim: true,
      maxlength: [5000, 'Subjective notes must be at most 5000 characters.'],
      default: '',
    },
    objective: {
      type: String,
      trim: true,
      maxlength: [5000, 'Objective notes must be at most 5000 characters.'],
      default: '',
    },
    assessment: {
      type: String,
      trim: true,
      maxlength: [5000, 'Assessment notes must be at most 5000 characters.'],
      default: '',
    },
    plan: {
      type: String,
      trim: true,
      maxlength: [5000, 'Plan notes must be at most 5000 characters.'],
      default: '',
    },
    submittedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

therapistSessionReportSchema.index(
  { therapist: 1, user: 1, appointmentRef: 1 },
  {
    unique: true,
    partialFilterExpression: {
      appointmentRef: { $exists: true, $type: 'string', $ne: '' },
    },
  },
);

therapistSessionReportSchema.index(
  { therapist: 1, user: 1, sessionAtBucket: 1 },
  {
    unique: true,
    partialFilterExpression: {
      sessionAtBucket: { $exists: true, $type: 'date' },
    },
  },
);

module.exports = mongoose.model('TherapistSessionReport', therapistSessionReportSchema);
