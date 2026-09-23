const mongoose = require('mongoose');

// A student picks their own classroom once, freely. After that they can only move
// by requesting a transfer, which the home teacher of the classroom they are
// LEAVING approves or rejects.
const classroomTransferRequestSchema = new mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    fromClassroom: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Classroom',
      required: true,
      index: true,
    },
    toClassroom: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Classroom',
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'cancelled'],
      default: 'pending',
      index: true,
    },
    reason: { type: String, trim: true, default: '', maxlength: 500 },

    decidedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    // Which rung of the approver fallback chain actually decided this, so a
    // classroom with no home teacher is visible rather than silently wedged.
    decidedByRole: {
      type: String,
      enum: ['home_teacher', 'fallback_teacher', 'admin', null],
      default: null,
    },
    decidedAt: { type: Date, default: null },
    decisionNote: { type: String, trim: true, default: '', maxlength: 500 },
    requestedAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true },
);

// One open request per student at a time.
// Explicitly named for the same reason as teacherInvite: `student` already has a
// field-level index owning the name `student_1`.
classroomTransferRequestSchema.index(
  { student: 1 },
  {
    name: 'student_pending_unique',
    unique: true,
    partialFilterExpression: { status: 'pending' },
  },
);
classroomTransferRequestSchema.index({
  fromClassroom: 1,
  status: 1,
  requestedAt: 1,
});
classroomTransferRequestSchema.index({ organization: 1, status: 1 });

const ClassroomTransferRequest = mongoose.model(
  'ClassroomTransferRequest',
  classroomTransferRequestSchema,
);

module.exports = ClassroomTransferRequest;
