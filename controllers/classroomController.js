const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');
const User = require('../models/userModel');
const Classroom = require('../models/classroomModel');
const Referral = require('../models/referralModel');
const ClassroomTransferRequest = require('../models/classroomTransferRequestModel');
const {
  asObjectIdOrNull,
  escapeRegex,
  requireOrganization,
  ensureTeacherClassroom,
  teacherClassroomIds,
  approvableClassroomIds,
} = require('../utils/orgScope');

const parsePositiveInt = (value, fallback, max) => {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return max ? Math.min(parsed, max) : parsed;
};

const classroomLabel = (classroom) => {
  if (!classroom) return '';
  if (classroom.grade) {
    return classroom.section
      ? `${classroom.grade}-${classroom.section}`
      : String(classroom.grade);
  }
  return classroom.name || '';
};

// The complete set of student fields a teacher may ever read. Never return a raw
// user document — signUp used to, and that leaked roles, organization and
// passwordChangedAt automatically as the schema grew.
const mapStudentForTeacher = (student, classroom, referral) => ({
  id: student._id,
  name: student.name,
  classroomId: classroom?._id || student.classroom || null,
  classroomName: classroom?.name || '',
  classroomLabel: classroomLabel(classroom),
  grade: classroom?.grade || '',
  section: classroom?.section || '',
  openReferral: referral
    ? { id: referral._id, status: referral.status }
    : null,
});

const mapClassroomForStudent = (classroom) => ({
  id: classroom._id,
  name: classroom.name,
  grade: classroom.grade || '',
  section: classroom.section || '',
  academicYear: classroom.academicYear || '',
  label: classroomLabel(classroom),
});

/* ------------------------------------------------------------------ teacher */

// GET /api/v1/classrooms/mine
exports.getMyClassrooms = catchAsync(async (req, res, next) => {
  const organizationId = requireOrganization(req.user);

  const classrooms = await Classroom.find({
    organization: organizationId,
    teachers: req.user._id,
    isActive: true,
  })
    .select('name grade section academicYear homeTeacher')
    .sort({ grade: 1, section: 1, name: 1 })
    .lean();

  const classroomIds = classrooms.map((c) => c._id);
  const approvableIds = new Set(
    (await approvableClassroomIds(req.user)).map(String),
  );

  const [counts, openReferrals, pendingTransfers] = await Promise.all([
    User.aggregate([
      { $match: { classroom: { $in: classroomIds }, role: 'user' } },
      { $group: { _id: '$classroom', count: { $sum: 1 } } },
    ]),
    Referral.aggregate([
      {
        $match: {
          classroom: { $in: classroomIds },
          openKey: { $type: 'string' },
          source: 'teacher_manual', // self-flags are invisible to teachers
        },
      },
      { $group: { _id: '$classroom', count: { $sum: 1 } } },
    ]),
    ClassroomTransferRequest.aggregate([
      { $match: { fromClassroom: { $in: classroomIds }, status: 'pending' } },
      { $group: { _id: '$fromClassroom', count: { $sum: 1 } } },
    ]),
  ]);

  const toMap = (rows) =>
    rows.reduce((acc, row) => {
      acc[String(row._id)] = row.count;
      return acc;
    }, {});
  const countMap = toMap(counts);
  const referralMap = toMap(openReferrals);
  const transferMap = toMap(pendingTransfers);

  const data = classrooms.map((c) => {
    const key = String(c._id);
    const isHomeTeacher = String(c.homeTeacher || '') === String(req.user._id);
    const canApproveTransfers = approvableIds.has(key);
    return {
      id: c._id,
      name: c.name,
      grade: c.grade || '',
      section: c.section || '',
      academicYear: c.academicYear || '',
      label: classroomLabel(c),
      studentCount: countMap[key] || 0,
      openReferralCount: referralMap[key] || 0,
      pendingTransferRequests: canApproveTransfers ? transferMap[key] || 0 : 0,
      isHomeTeacher,
      canApproveTransfers,
    };
  });

  res.status(200).json({
    status: 'success',
    results: data.length,
    needsClassroomAssignment: data.length === 0,
    canApproveTransfersAnywhere: data.some((c) => c.canApproveTransfers),
    isHomeTeacherAnywhere: data.some((c) => c.isHomeTeacher),
    data,
  });
});

// GET /api/v1/classrooms/:id/students
exports.getClassroomStudents = catchAsync(async (req, res, next) => {
  const organizationId = requireOrganization(req.user);
  const classroom = await ensureTeacherClassroom({
    teacherId: req.user._id,
    organizationId,
    classroomId: req.params.id,
  });

  const page = parsePositiveInt(req.query.page, 1);
  const limit = parsePositiveInt(req.query.limit, 50, 100);
  const search = String(req.query.search || '').trim();

  const filter = { classroom: classroom._id, role: 'user' };
  if (search) {
    filter.name = { $regex: escapeRegex(search), $options: 'i' };
  }

  // Paginate in Mongo. getMyAssignedClients slices a fully materialised array in
  // JS; that pattern is not worth copying here — these queries are index-covered.
  const [students, total] = await Promise.all([
    User.find(filter)
      .select('name classroom')
      .sort({ name: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    User.countDocuments(filter),
  ]);

  const referrals = students.length
    ? await Referral.find({
        student: { $in: students.map((s) => s._id) },
        openKey: { $type: 'string' },
        // Teacher-sourced only. A self_assessment flag is the student's private
        // screening result and must never surface on a teacher's roster.
        source: 'teacher_manual',
      })
        .select('student status')
        .lean()
    : [];
  const referralByStudent = referrals.reduce((acc, r) => {
    acc[String(r.student)] = r;
    return acc;
  }, {});

  res.status(200).json({
    status: 'success',
    results: students.length,
    classroom: {
      id: classroom._id,
      name: classroom.name,
      label: classroomLabel(classroom),
      isHomeTeacher:
        String(classroom.homeTeacher || '') === String(req.user._id),
    },
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
    data: students.map((s) =>
      mapStudentForTeacher(s, classroom, referralByStudent[String(s._id)]),
    ),
  });
});

// GET /api/v1/classrooms/students/search?q=
// Scoped to the union of this teacher's classrooms, never the whole school — a
// teacher must not be able to enumerate the student body.
exports.searchMyStudents = catchAsync(async (req, res, next) => {
  requireOrganization(req.user);

  const q = String(req.query.q || '').trim();
  if (q.length < 2) {
    return res.status(200).json({
      status: 'success',
      results: 0,
      pagination: { page: 1, limit: 0, total: 0, totalPages: 1 },
      data: [],
    });
  }

  const classroomIds = await teacherClassroomIds(req.user._id);
  if (!classroomIds.length) {
    return res.status(200).json({
      status: 'success',
      results: 0,
      pagination: { page: 1, limit: 0, total: 0, totalPages: 1 },
      data: [],
    });
  }

  const page = parsePositiveInt(req.query.page, 1);
  const limit = parsePositiveInt(req.query.limit, 20, 25);

  const filter = {
    role: 'user',
    classroom: { $in: classroomIds },
    name: { $regex: escapeRegex(q), $options: 'i' },
  };

  const [students, total] = await Promise.all([
    User.find(filter)
      .select('name classroom')
      .sort({ name: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    User.countDocuments(filter),
  ]);

  const [classrooms, referrals] = await Promise.all([
    Classroom.find({ _id: { $in: classroomIds } })
      .select('name grade section')
      .lean(),
    students.length
      ? Referral.find({
          student: { $in: students.map((s) => s._id) },
          openKey: { $type: 'string' },
          source: 'teacher_manual', // see getClassroomStudents
        })
          .select('student status')
          .lean()
      : [],
  ]);

  const classroomById = classrooms.reduce((acc, c) => {
    acc[String(c._id)] = c;
    return acc;
  }, {});
  const referralByStudent = referrals.reduce((acc, r) => {
    acc[String(r.student)] = r;
    return acc;
  }, {});

  res.status(200).json({
    status: 'success',
    results: students.length,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
    data: students.map((s) =>
      mapStudentForTeacher(
        s,
        classroomById[String(s.classroom)],
        referralByStudent[String(s._id)],
      ),
    ),
  });
});

/* ------------------------------------------------------------------ student */

// GET /api/v1/classrooms/available
exports.getAvailableClassrooms = catchAsync(async (req, res, next) => {
  if (req.user.role !== 'user') {
    return next(
      new AppError('Only students can browse classrooms to join.', 403),
    );
  }
  if (!req.user.organization) {
    return next(
      new AppError(
        'Join your school with its organization code first.',
        400,
      ),
    );
  }

  const classrooms = await Classroom.find({
    organization: req.user.organization,
    isActive: true,
  })
    .select('name grade section academicYear homeTeacher')
    .populate('homeTeacher', 'name')
    .sort({ grade: 1, section: 1, name: 1 })
    .lean();

  res.status(200).json({
    status: 'success',
    results: classrooms.length,
    currentClassroomId: req.user.classroom || null,
    data: classrooms.map((c) => ({
      ...mapClassroomForStudent(c),
      homeTeacherName: c.homeTeacher?.name || '',
    })),
  });
});

// GET /api/v1/classrooms/my-classroom
exports.getMyClassroom = catchAsync(async (req, res, next) => {
  if (!req.user.classroom) {
    return res.status(200).json({ status: 'success', data: null });
  }

  const classroom = await Classroom.findById(req.user.classroom)
    .select('name grade section academicYear homeTeacher')
    .populate('homeTeacher', 'name')
    .lean();

  if (!classroom) {
    return res.status(200).json({ status: 'success', data: null });
  }

  const pendingTransfer = await ClassroomTransferRequest.findOne({
    student: req.user._id,
    status: 'pending',
  })
    .populate('toClassroom', 'name grade section')
    .lean();

  res.status(200).json({
    status: 'success',
    data: {
      ...mapClassroomForStudent(classroom),
      homeTeacherName: classroom.homeTeacher?.name || '',
      pendingTransfer: pendingTransfer
        ? {
            id: pendingTransfer._id,
            toClassroom: mapClassroomForStudent(pendingTransfer.toClassroom),
            requestedAt: pendingTransfer.requestedAt,
          }
        : null,
    },
  });
});

// POST /api/v1/classrooms/:id/join — the first pick is free; every move after is
// a transfer request approved by the home teacher of the class being left.
exports.joinClassroom = catchAsync(async (req, res, next) => {
  if (req.user.role !== 'user') {
    return next(new AppError('Only students can join a classroom.', 403));
  }
  if (!req.user.organization) {
    return next(
      new AppError('Join your school with its organization code first.', 400),
    );
  }
  if (req.user.classroom) {
    return next(
      new AppError(
        'You are already in a classroom. Request a transfer to change it.',
        409,
      ),
    );
  }

  const classroomId = asObjectIdOrNull(req.params.id);
  if (!classroomId) return next(new AppError('Classroom not found.', 404));

  const classroom = await Classroom.findOne({
    _id: classroomId,
    organization: req.user.organization,
    isActive: true,
  })
    .select('name grade section academicYear')
    .lean();

  if (!classroom) return next(new AppError('Classroom not found.', 404));

  req.user.classroom = classroom._id;
  await req.user.save({ validateBeforeSave: false });

  res.status(200).json({
    status: 'success',
    message: 'You have joined this classroom.',
    data: mapClassroomForStudent(classroom),
  });
});

/* -------------------------------------------------------------------- admin */

// POST /api/v1/classrooms
exports.createClassroom = catchAsync(async (req, res, next) => {
  const organization = asObjectIdOrNull(req.body?.organizationId);
  if (!organization) {
    return next(new AppError('A valid organizationId is required.', 400));
  }

  const name = String(req.body?.name || '').trim();
  if (!name) return next(new AppError('Classroom name is required.', 400));

  try {
    const classroom = await Classroom.create({
      organization,
      name,
      grade: String(req.body?.grade || '').trim(),
      section: String(req.body?.section || '').trim(),
      academicYear: String(req.body?.academicYear || '').trim(),
      homeTeacher: asObjectIdOrNull(req.body?.homeTeacherId),
      teachers: Array.isArray(req.body?.teacherIds)
        ? req.body.teacherIds.map(asObjectIdOrNull).filter(Boolean)
        : [],
      createdBy: req.user._id,
    });

    return res.status(201).json({ status: 'success', data: classroom });
  } catch (err) {
    // errorController.js is required by index.js but never mounted — the inline
    // handler wins and does not translate Mongo errors, so an E11000 would reach
    // the client as a raw 500.
    if (err?.code === 11000) {
      return next(
        new AppError(
          'A classroom with this name already exists for that school and academic year.',
          409,
        ),
      );
    }
    throw err;
  }
});

// GET /api/v1/classrooms?organizationId=
exports.listClassrooms = catchAsync(async (req, res, next) => {
  const filter = {};
  const organization = asObjectIdOrNull(req.query.organizationId);
  if (organization) filter.organization = organization;

  const classrooms = await Classroom.find(filter)
    .populate('homeTeacher', 'name email')
    .sort({ organization: 1, grade: 1, section: 1 })
    .lean();

  res.status(200).json({
    status: 'success',
    results: classrooms.length,
    data: classrooms,
  });
});

// PATCH /api/v1/classrooms/:id
exports.updateClassroom = catchAsync(async (req, res, next) => {
  const classroom = await Classroom.findById(req.params.id);
  if (!classroom) return next(new AppError('Classroom not found.', 404));

  ['name', 'grade', 'section', 'academicYear'].forEach((field) => {
    if (req.body?.[field] !== undefined) {
      classroom[field] = String(req.body[field] || '').trim();
    }
  });
  if (req.body?.isActive !== undefined) {
    classroom.isActive = Boolean(req.body.isActive);
  }

  await classroom.save();
  res.status(200).json({ status: 'success', data: classroom });
});

// PATCH /api/v1/classrooms/:id/home-teacher
exports.setHomeTeacher = catchAsync(async (req, res, next) => {
  const classroom = await Classroom.findById(req.params.id);
  if (!classroom) return next(new AppError('Classroom not found.', 404));

  const teacherId = asObjectIdOrNull(req.body?.teacherUserId);
  if (!teacherId) return next(new AppError('teacherUserId is required.', 400));

  const teacher = await User.findById(teacherId).select('role roles').lean();
  const isTeacher =
    teacher &&
    (teacher.role === 'teacher' || (teacher.roles || []).includes('teacher'));
  if (!isTeacher) {
    return next(new AppError('That user is not a teacher.', 400));
  }

  classroom.homeTeacher = teacherId; // pre('save') also adds them to teachers[]
  await classroom.save();

  res.status(200).json({ status: 'success', data: classroom });
});

// POST /api/v1/classrooms/:id/teachers
exports.addClassroomTeachers = catchAsync(async (req, res, next) => {
  const classroom = await Classroom.findById(req.params.id);
  if (!classroom) return next(new AppError('Classroom not found.', 404));

  const ids = Array.isArray(req.body?.teacherUserIds)
    ? req.body.teacherUserIds.map(asObjectIdOrNull).filter(Boolean)
    : [];

  const emails = Array.isArray(req.body?.emails)
    ? req.body.emails
        .map((e) => String(e || '').trim().toLowerCase())
        .filter(Boolean)
    : [];

  if (emails.length) {
    const byEmail = await User.find({
      email: { $in: emails },
      $or: [{ role: 'teacher' }, { roles: 'teacher' }],
    })
      .select('_id')
      .lean();
    byEmail.forEach((u) => ids.push(u._id));
  }

  if (!ids.length) {
    return next(new AppError('No valid teachers were provided.', 400));
  }

  await Classroom.updateOne(
    { _id: classroom._id },
    { $addToSet: { teachers: { $each: ids } } },
  );

  const updated = await Classroom.findById(classroom._id).lean();
  res.status(200).json({ status: 'success', data: updated });
});

// DELETE /api/v1/classrooms/:id/teachers/:userId
exports.removeClassroomTeacher = catchAsync(async (req, res, next) => {
  const classroom = await Classroom.findById(req.params.id);
  if (!classroom) return next(new AppError('Classroom not found.', 404));

  const teacherId = asObjectIdOrNull(req.params.userId);
  if (!teacherId) return next(new AppError('Teacher not found.', 404));

  const update = { $pull: { teachers: teacherId } };
  if (String(classroom.homeTeacher || '') === String(teacherId)) {
    update.$set = { homeTeacher: null };
  }

  await Classroom.updateOne({ _id: classroom._id }, update);

  const updated = await Classroom.findById(classroom._id).lean();
  res.status(200).json({ status: 'success', data: updated });
});

module.exports.mapStudentForTeacher = mapStudentForTeacher;
module.exports.classroomLabel = classroomLabel;
