const mongoose = require('mongoose');

const therapistQuizAssignmentSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Assigned user is required.'],
      index: true,
    },
    therapist: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Assigning therapist is required.'],
      index: true,
    },
    quiz: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Quiz',
      required: [true, 'Assigned quiz is required.'],
      index: true,
    },
    status: {
      type: String,
      enum: ['assigned', 'in_progress', 'completed', 'revoked'],
      default: 'assigned',
      index: true,
    },
    assignedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    dueAt: {
      type: Date,
      default: null,
      index: true,
    },
    startedAt: {
      type: Date,
      default: null,
    },
    completedAt: {
      type: Date,
      default: null,
    },
    revokedAt: {
      type: Date,
      default: null,
    },
    note: {
      type: String,
      trim: true,
      maxlength: [1200, 'Assignment note must be at most 1200 characters.'],
    },
    source: {
      type: String,
      enum: ['therapist_manual'],
      default: 'therapist_manual',
    },
  },
  { timestamps: true },
);

therapistQuizAssignmentSchema.index({ therapist: 1, user: 1, assignedAt: -1 });
therapistQuizAssignmentSchema.index({ therapist: 1, user: 1, quiz: 1, status: 1 });

module.exports = mongoose.model('TherapistQuizAssignment', therapistQuizAssignmentSchema);
