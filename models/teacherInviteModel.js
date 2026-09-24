const mongoose = require('mongoose');

// The school's list of teacher email addresses. A `teacher` role can only ever
// originate from a row in this collection, written by an admin — it is never read
// from a request body.
//
// This is a separate collection rather than an array on Organization because
// GET /api/v1/organizations is protect-only and returns every organization to any
// authenticated user, students included. Teacher emails on that document would be
// a staff directory leak for every school on the platform.
const teacherInviteSchema = new mongoose.Schema(
  {
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: [true, 'Organization is required.'],
      index: true,
    },
    email: {
      type: String,
      required: [true, 'Invite email is required.'],
      lowercase: true,
      trim: true,
      index: true,
    },
    name: { type: String, trim: true, default: '', maxlength: 160 },
    status: {
      type: String,
      enum: ['pending', 'claimed', 'revoked'],
      default: 'pending',
      index: true,
    },
    defaultClassrooms: [
      { type: mongoose.Schema.Types.ObjectId, ref: 'Classroom' },
    ],
    invitedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    invitedAt: { type: Date, default: Date.now },
    claimedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    claimedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    source: {
      type: String,
      enum: ['admin_manual', 'admin_csv', 'admin_auto_promote'],
      default: 'admin_manual',
    },
    note: { type: String, trim: true, default: '', maxlength: 500 },
  },
  { timestamps: true },
);

// One live invite per email address globally: two schools cannot both claim the
// same teacher, and an invite cannot be double-provisioned.
// Explicitly named: the field-level `index: true` on email already claims the
// auto-generated name `email_1`, and an unnamed index here would collide with it.
teacherInviteSchema.index(
  { email: 1 },
  {
    name: 'email_pending_unique',
    unique: true,
    partialFilterExpression: { status: 'pending' },
  },
);
teacherInviteSchema.index({ organization: 1, status: 1, email: 1 });
teacherInviteSchema.index({ organization: 1, invitedAt: -1 });

const TeacherInvite = mongoose.model('TeacherInvite', teacherInviteSchema);

module.exports = TeacherInvite;
