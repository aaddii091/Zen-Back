const mongoose = require('mongoose');

const CONCERN_TAGS = [
  'academic_decline',
  'withdrawn_isolated',
  'behavioural_change',
  'peer_conflict_bullying',
  'attendance',
  'anxiety_stress',
  'mood_low',
  'sleep_fatigue',
  'family_situation',
  'other',
];

const URGENCY_RANK = { low: 1, medium: 2, high: 3 };

// A teacher's referral of a student to the school's help group (the therapists on
// that organization's roster). Shaped after therapistQuizAssignmentModel, which is
// the existing "one actor assigns something about a student to another" model.
const referralSchema = new mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    // Null for a self_assessment flag: nobody referred this student, their own
    // screening result did. Teacher-facing queries filter on `teacher`, so a null
    // here is also what keeps self-flags invisible to every teacher.
    teacher: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
      required: [
        function () {
          return this.source !== 'self_assessment';
        },
        'A teacher referral must record who filed it.',
      ],
    },
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    classroom: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Classroom',
      default: null,
      index: true,
    },

    // Frozen at filing time. A referral filed in September must still read
    // "Grade 9-B" after the student transfers or is promoted.
    classroomSnapshot: {
      name: { type: String, default: '' },
      grade: { type: String, default: '' },
      section: { type: String, default: '' },
    },

    status: {
      type: String,
      enum: ['pending', 'acknowledged', 'in_progress', 'closed'],
      default: 'pending',
      index: true,
    },
    urgency: {
      type: String,
      enum: ['low', 'medium', 'high'],
      default: 'medium',
      index: true,
    },
    // Enum strings sort lexically ('high' < 'low' < 'medium'), which would put
    // medium on top of the inbox. Sort on this instead.
    urgencyRank: { type: Number, default: 2, index: true },

    // String(student) while the referral is open, null once closed. This exists
    // because partialFilterExpression does not support $in, so "one open referral
    // per student" cannot be expressed as status: { $in: [...] }. Same trick
    // therapistSessionReportModel uses with sessionAtBucket.
    openKey: { type: String, default: null },

    reason: {
      type: String,
      required: [true, 'A referral needs a reason.'],
      trim: true,
      maxlength: 2000,
    },
    concernTags: {
      type: [{ type: String, enum: CONCERN_TAGS }],
      default: [],
    },
    observedSince: { type: Date, default: null },

    additionalNotes: [
      {
        teacher: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        note: { type: String, trim: true, maxlength: 1000 },
        at: { type: Date, default: Date.now },
      },
    ],

    assignedTherapist: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    acknowledgedAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },
    withdrawnAt: { type: Date, default: null },

    closureOutcome: {
      type: String,
      enum: [
        'support_started',
        'referred_external',
        'no_action_needed',
        'duplicate',
        'withdrawn',
        null,
      ],
      default: null,
    },
    // Therapist-only. Never present in a teacher-facing projection.
    closureNote: { type: String, trim: true, default: '', maxlength: 2000 },
    // The deliberately shareable half — what the therapist chooses to tell the
    // referring teacher. Its existence is what stops clinical notes leaking by default.
    closureSummaryForTeacher: {
      type: String,
      trim: true,
      default: '',
      maxlength: 500,
    },

    statusHistory: [
      {
        status: { type: String },
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        at: { type: Date, default: Date.now },
        note: { type: String, trim: true, maxlength: 500 }, // therapist-only
      },
    ],

    // Set when the student changes classroom while this referral is open. The
    // referral stays with the original referrer; this is signal for the therapist.
    studentTransferredAt: { type: Date, default: null },
    studentClassroomAtTransfer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Classroom',
      default: null,
    },

    teacherLastViewedAt: { type: Date, default: null },
    therapistFirstViewedAt: { type: Date, default: null },

    source: {
      type: String,
      enum: ['teacher_manual', 'self_assessment'],
      default: 'teacher_manual',
      index: true,
    },

    // Snapshot of the screening that triggered a self_assessment flag. Frozen, so
    // a later retake does not rewrite the evidence the therapist acted on.
    selfAssessment: {
      instrument: { type: String, default: '' }, // e.g. 'mini_16pf'
      distressScore: { type: Number, default: null },
      threshold: { type: Number, default: null },
      category: { type: String, default: '' },
      traitScores: { type: mongoose.Schema.Types.Mixed, default: null },
      takenAt: { type: Date, default: null },
    },
  },
  { timestamps: true },
);

referralSchema.index({
  organization: 1,
  status: 1,
  urgencyRank: -1,
  createdAt: 1,
}); // the inbox, in triage order
referralSchema.index({ teacher: 1, createdAt: -1 }); // "My Referrals"
referralSchema.index({ student: 1, createdAt: -1 });
referralSchema.index({ assignedTherapist: 1, status: 1, createdAt: -1 });
referralSchema.index({ organization: 1, classroom: 1, status: 1 });

// One OPEN referral per student per organization — not per teacher. Two teachers
// noticing the same struggling child should converge on one thread.
referralSchema.index(
  { organization: 1, openKey: 1 },
  { unique: true, partialFilterExpression: { openKey: { $type: 'string' } } },
);

// Both derived fields must also be set explicitly in any findOneAndUpdate path;
// this hook does not fire for update queries.
referralSchema.pre('save', function (next) {
  this.urgencyRank = URGENCY_RANK[this.urgency] || 2;
  this.openKey = this.status === 'closed' ? null : String(this.student);
  next();
});

const Referral = mongoose.model('Referral', referralSchema);

module.exports = Referral;
module.exports.CONCERN_TAGS = CONCERN_TAGS;
module.exports.URGENCY_RANK = URGENCY_RANK;
