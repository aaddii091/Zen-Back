const mongoose = require('mongoose');

const URGENCY_RANK = { low: 1, medium: 2, high: 3 };

const STATUSES = ['pending', 'acknowledged', 'parent_contacted', 'closed'];
const OPEN_STATUSES = ['pending', 'acknowledged', 'parent_contacted'];

const CONTACT_METHODS = ['phone', 'in_person', 'email', 'letter', 'other'];

// A counsellor handing a student's case up to their school's admin, so the
// admin can take it up with the student's parents.
//
// Deliberately NOT a second stage on Referral. A referral is a teacher noticing
// something; an escalation is a counsellor who has already been working with the
// student. The two have different actors, different audiences and different
// confidentiality rules, and a counsellor routinely escalates a client who was
// never referred by a teacher at all (a self-assessment flag, or a student the
// school assigned directly). Folding this into Referral would also collide with
// its `organization + openKey` unique index.
//
// Shaped on referralModel.js, which is the house pattern for "one actor hands a
// student's case to another".
const escalationSchema = new mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    counsellor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'An escalation must record which counsellor raised it.'],
      index: true,
    },
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    // Set when the escalation grew out of a teacher referral, so the admin can
    // see the original concern. Null for a counsellor's own client.
    referral: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Referral',
      default: null,
    },

    // Frozen at filing time, same rationale as referralModel.js:59-63 — an
    // escalation raised in September must still read "Grade 9-B" after the
    // student transfers or is promoted.
    classroomSnapshot: {
      name: { type: String, default: '' },
      grade: { type: String, default: '' },
      section: { type: String, default: '' },
    },

    status: {
      type: String,
      enum: STATUSES,
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

    // String(student) while open, null once closed. partialFilterExpression does
    // not support $in, so "one open escalation per student" cannot be expressed
    // as status: { $in: [...] }. Same trick referralModel.js uses with openKey.
    openKey: { type: String, default: null },

    reason: {
      type: String,
      required: [true, 'An escalation needs a reason.'],
      trim: true,
      maxlength: 2000,
    },

    // What the admin did about it.
    parentContact: {
      contactedAt: { type: Date, default: null },
      method: { type: String, enum: [...CONTACT_METHODS, null], default: null },
      byAdmin: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null,
      },
      outcome: { type: String, trim: true, default: '', maxlength: 1000 },
    },

    // Admin-only. Never present in a counsellor-facing projection — the same
    // split referralModel.js:130-139 uses to stop clinical notes leaking by
    // default, pointed the other way: what the admin learns from a parent is not
    // automatically the counsellor's to read.
    adminNotes: { type: String, trim: true, default: '', maxlength: 2000 },
    // The deliberately shareable half, travelling back down to the counsellor.
    summaryForCounsellor: {
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
        note: { type: String, trim: true, maxlength: 500 }, // admin-only
      },
    ],

    // Who opened this case, and when. Capped in the controller.
    accessLog: [
      {
        viewer: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        viewerRole: { type: String, trim: true, default: '' },
        at: { type: Date, default: Date.now },
      },
    ],

    acknowledgedAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

escalationSchema.index({
  organization: 1,
  status: 1,
  urgencyRank: -1,
  createdAt: 1,
}); // the admin inbox, in triage order
escalationSchema.index({ counsellor: 1, createdAt: -1 }); // "My escalations"
escalationSchema.index({ student: 1, createdAt: -1 });

// One OPEN escalation per student per school — two counsellors raising the same
// child should converge on one thread, exactly as referrals do.
escalationSchema.index(
  { organization: 1, openKey: 1 },
  { unique: true, partialFilterExpression: { openKey: { $type: 'string' } } },
);

// Both derived fields must also be set explicitly in any findOneAndUpdate path;
// this hook does not fire for update queries.
escalationSchema.pre('save', function (next) {
  this.urgencyRank = URGENCY_RANK[this.urgency] || 2;
  this.openKey = this.status === 'closed' ? null : String(this.student);
  next();
});

const Escalation = mongoose.model('Escalation', escalationSchema);

module.exports = Escalation;
module.exports.STATUSES = STATUSES;
module.exports.OPEN_STATUSES = OPEN_STATUSES;
module.exports.CONTACT_METHODS = CONTACT_METHODS;
module.exports.URGENCY_RANK = URGENCY_RANK;
