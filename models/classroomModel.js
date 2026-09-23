const mongoose = require('mongoose');

// A classroom is a named group inside one organization (school).
//
// Membership deliberately lives on the student, as `User.classroom` — a single
// ObjectId. There is no students[] array here. "A student belongs to exactly one
// classroom at a time" is a cardinality constraint, and a single-valued field on
// the student enforces it structurally; an array here would need an invariant
// across N documents that nothing ever checks. It also makes an approved transfer
// one atomic single-document update instead of a multi-document move, which
// matters because transactions require a replica set.
const classroomSchema = new mongoose.Schema(
  {
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: [true, 'Organization is required.'],
      index: true,
    },
    name: {
      type: String,
      required: [true, 'Classroom name is required.'],
      trim: true,
      maxlength: 120,
    },
    grade: { type: String, trim: true, default: '', maxlength: 40 },
    section: { type: String, trim: true, default: '', maxlength: 40 },
    academicYear: { type: String, trim: true, default: '', maxlength: 20 },

    // The home teacher approves transfers OUT of this classroom. Everyone in
    // teachers[] may read the roster and file referrals; only the home teacher
    // (or the fallback chain in the controller) may decide a transfer.
    homeTeacher: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    teachers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

    isActive: { type: Boolean, default: true, index: true },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true },
);

classroomSchema.index(
  { organization: 1, name: 1, academicYear: 1 },
  { unique: true },
);
classroomSchema.index({ teachers: 1, isActive: 1 });
classroomSchema.index({ organization: 1, isActive: 1, grade: 1, section: 1 });

// A home teacher must always also be a teacher of the classroom.
classroomSchema.pre('save', function (next) {
  if (this.homeTeacher) {
    const exists = this.teachers.some(
      (id) => String(id) === String(this.homeTeacher),
    );
    if (!exists) this.teachers.push(this.homeTeacher);
  }
  next();
});

const Classroom = mongoose.model('Classroom', classroomSchema);

module.exports = Classroom;
