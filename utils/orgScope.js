const mongoose = require('mongoose');
const AppError = require('./appError');
const User = require('../models/userModel');
const Organization = require('../models/organizationModel');
const Classroom = require('../models/classroomModel');

const asObjectIdOrNull = (value) => {
  const raw = String(value || '').trim();
  return mongoose.Types.ObjectId.isValid(raw)
    ? new mongoose.Types.ObjectId(raw)
    : null;
};

// Escape regex metacharacters before interpolating user input into a $regex.
const escapeRegex = (value) =>
  String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Teachers and students carry their org on the user document.
const requireOrganization = (user) => {
  if (!user?.organization) {
    throw new AppError(
      'Your account is not linked to a school yet. Ask your administrator.',
      400,
    );
  }
  return user.organization;
};

// Therapists do NOT. Nothing in the codebase ever sets User.organization for a
// therapist — redeemOrganizationCode is the only writer and it is gated to
// role === 'user'. Therapists are bound to schools only through
// Organization.therapistRoster, so a naive { organization: req.user.organization }
// filter returns an empty inbox for every therapist and looks like a bug here.
const resolveTherapistOrgIds = async (user) => {
  const orgs = await Organization.find({ therapistRoster: user._id })
    .select('_id')
    .lean();
  const ids = orgs.map((o) => o._id);

  if (
    user.organization &&
    !ids.some((id) => String(id) === String(user.organization))
  ) {
    ids.push(user.organization);
  }

  if (!ids.length) {
    throw new AppError(
      'You are not on any school’s therapist roster.',
      403,
    );
  }
  return ids;
};

// 404 rather than 403 on a classroom the teacher does not own — do not confirm
// that a classroom exists to someone with no business knowing.
const ensureTeacherClassroom = async ({
  teacherId,
  organizationId,
  classroomId,
  requireHome = false,
}) => {
  const id = asObjectIdOrNull(classroomId);
  if (!id) throw new AppError('Classroom not found.', 404);

  const classroom = await Classroom.findOne({
    _id: id,
    organization: organizationId,
    teachers: teacherId,
    isActive: true,
  });
  if (!classroom) throw new AppError('Classroom not found.', 404);

  if (requireHome && String(classroom.homeTeacher || '') !== String(teacherId)) {
    throw new AppError(
      'Only the home teacher of this classroom can decide transfers.',
      403,
    );
  }
  return classroom;
};

// Every classroom id this teacher is attached to. The union of their students is
// the only population they may ever read or search.
const teacherClassroomIds = async (teacherId) =>
  Classroom.find({ teachers: teacherId, isActive: true }).distinct('_id');

// Gate for anything addressed at one student: they must be an actual student in
// one of this teacher's classrooms.
const ensureTeacherStudent = async ({ teacherId, studentId }) => {
  const id = asObjectIdOrNull(studentId);
  if (!id) throw new AppError('Student not found.', 404);

  const classroomIds = await teacherClassroomIds(teacherId);
  if (!classroomIds.length) throw new AppError('Student not found.', 404);

  const student = await User.findOne({
    _id: id,
    role: 'user',
    classroom: { $in: classroomIds },
  })
    .select('name email role organization classroom')
    .lean();

  if (!student) throw new AppError('Student not found.', 404);
  return student;
};

const assertSameOrg = (a, b) => {
  if (String(a || '') !== String(b || '')) {
    throw new AppError('This record belongs to a different school.', 403);
  }
};

// Which of this teacher's classrooms they may approve transfers OUT of.
//
// One implementation, shared by the transfer-decide guard, the transfer listing,
// and the classroom list that drives the UI tab. Keeping this in three places is
// how you get a teacher who is allowed to decide a request but can never see it.
//
// Rule: I am the home teacher, OR the classroom has no usable home teacher (never
// set, or set to someone who is no longer a teacher) and I teach it.
const approvableClassroomIds = async (teacherUser) => {
  const classrooms = await Classroom.find({
    teachers: teacherUser._id,
    isActive: true,
  })
    .select('_id homeTeacher')
    .lean();

  const otherHomeTeacherIds = classrooms
    .filter(
      (c) => c.homeTeacher && String(c.homeTeacher) !== String(teacherUser._id),
    )
    .map((c) => c.homeTeacher);

  const stillTeaching = new Set(
    otherHomeTeacherIds.length
      ? (
          await User.find({
            _id: { $in: otherHomeTeacherIds },
            $or: [{ role: 'teacher' }, { roles: 'teacher' }],
          })
            .select('_id')
            .lean()
        ).map((u) => String(u._id))
      : [],
  );

  return classrooms
    .filter((c) => {
      if (String(c.homeTeacher || '') === String(teacherUser._id)) return true;
      return !c.homeTeacher || !stillTeaching.has(String(c.homeTeacher));
    })
    .map((c) => c._id);
};

module.exports = {
  asObjectIdOrNull,
  escapeRegex,
  requireOrganization,
  resolveTherapistOrgIds,
  ensureTeacherClassroom,
  teacherClassroomIds,
  approvableClassroomIds,
  ensureTeacherStudent,
  assertSameOrg,
};
