const mongoose = require('mongoose');

// A counsellor's running note about a student.
//
// Separate from TherapistSessionReport, which is the formal SOAP write-up for a
// booked session and locks on submit. This is the quick, timestamped note a
// counsellor takes during or after a conversation — amendable, and shareable
// with the student's teacher one note at a time.
const attachmentSchema = new mongoose.Schema(
  {
    // Object key in Cloudflare R2. Never a URL: URLs are presigned per request
    // with a short TTL, so a stored one would be a stale link at best and a
    // long-lived unauthenticated handle to a student's notes at worst.
    r2Key: { type: String, required: true, trim: true },
    contentType: { type: String, required: true, trim: true },
    sizeBytes: { type: Number, min: 0, default: 0 },
    originalName: { type: String, trim: true, default: '', maxlength: 260 },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: true },
);

const counsellorNoteSchema = new mongoose.Schema(
  {
    counsellor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'A note must belong to a counsellor.'],
      index: true,
    },
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'A note must be about a student.'],
      index: true,
    },
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      default: null,
      index: true,
    },

    body: {
      type: String,
      trim: true,
      default: '',
      maxlength: [5000, 'A note must be at most 5000 characters.'],
    },

    // The clinically meaningful timestamp — when the conversation happened,
    // which is not always when the note was typed. createdAt/updatedAt remain
    // the audit trail of the record itself.
    noteAt: { type: Date, default: Date.now, index: true },

    // Opt-in, per note, never retroactive and never in bulk. Default false is
    // the whole point: a counsellor's notes are private to them unless they
    // make a deliberate decision about one specific note.
    visibleToTeacher: { type: Boolean, default: false, index: true },

    attachments: { type: [attachmentSchema], default: [] },
  },
  { timestamps: true },
);

counsellorNoteSchema.index({ counsellor: 1, student: 1, noteAt: -1 });
counsellorNoteSchema.index({ student: 1, visibleToTeacher: 1, noteAt: -1 });

// A note with neither text nor a photo is not a note.
counsellorNoteSchema.pre('validate', function (next) {
  const hasBody = String(this.body || '').trim().length > 0;
  const hasAttachment = (this.attachments || []).length > 0;
  if (!hasBody && !hasAttachment) {
    return next(new Error('A note needs either text or an attachment.'));
  }
  next();
});

module.exports = mongoose.model('CounsellorNote', counsellorNoteSchema);
