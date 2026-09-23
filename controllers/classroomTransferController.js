const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');
const User = require('../models/userModel');
const Classroom = require('../models/classroomModel');
const Referral = require('../models/referralModel');
const ClassroomTransferRequest = require('../models/classroomTransferRequestModel');
const {
  asObjectIdOrNull,
  approvableClassroomIds,
} = require('../utils/orgScope');

const parsePositiveInt = (value, fallback, max) => {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return max ? Math.min(parsed, max) : parsed;
};

const classroomBrief = (classroom) =>
  classroom
    ? {
        id: classroom._id,
        name: classroom.name,
        label: classroom.grade
          ? classroom.section
            ? `${classroom.grade}-${classroom.section}`
            : String(classroom.grade)
          : classroom.name,
      }
    : null;

const mapRequest = (request) => ({
  id: request._id,
  student: request.student?._id
    ? { id: request.student._id, name: request.student.name }
    : { id: request.student, name: '' },
  fromClassroom: classroomBrief(request.fromClassroom),
  toClassroom: classroomBrief(request.toClassroom),
  reason: request.reason || '',
  status: request.status,
  requestedAt: request.requestedAt,
  decidedAt: request.decidedAt,
  decisionNote: request.decisionNote || '',
});

// Who may decide a transfer out of this classroom. The fallback chain exists so a
// classroom whose home teacher was never set, or who has since been demoted, does
// not silently wedge every request filed against it.
const resolveApproverRole = async (classroom, user) => {
  const userId = String(user._id);
  const isAdmin =
    user.role === 'admin' || (user.roles || []).includes('admin');

  if (String(classroom.homeTeacher || '') === userId) return 'home_teacher';

  if (classroom.homeTeacher) {
    const home = await User.findById(classroom.homeTeacher)
      .select('role roles')
      .lean();
    const homeStillTeaches =
      home &&
      (home.role === 'teacher' || (home.roles || []).includes('teacher'));
    // A live home teacher owns the decision; nobody else may pre-empt them.
    if (homeStillTeaches) return isAdmin ? 'admin' : null;
  }

  const isClassroomTeacher = (classroom.teachers || []).some(
    (id) => String(id) === userId,
  );
  if (isClassroomTeacher) return 'fallback_teacher';
  if (isAdmin) return 'admin';
  return null;
};

/* ----------------------------------------------------------------- student */

// POST /api/v1/classroom-transfers
exports.createTransferRequest = catchAsync(async (req, res, next) => {
  if (req.user.role !== 'user') {
    return next(new AppError('Only students can request a class change.', 403));
  }
  if (!req.user.classroom) {
    return next(
      new AppError('Join a classroom before requesting a change.', 400),
    );
  }

  const toClassroomId = asObjectIdOrNull(req.body?.toClassroomId);
  if (!toClassroomId) {
    return next(new AppError('Pick the classroom you want to move to.', 400));
  }
  if (String(toClassroomId) === String(req.user.classroom)) {
    return next(new AppError('You are already in that classroom.', 400));
  }

  const target = await Classroom.findOne({
    _id: toClassroomId,
    organization: req.user.organization,
    isActive: true,
  })
    .select('_id')
    .lean();
  if (!target) return next(new AppError('Classroom not found.', 404));

  try {
    const request = await ClassroomTransferRequest.create({
      student: req.user._id,
      organization: req.user.organization,
      fromClassroom: req.user.classroom,
      toClassroom: toClassroomId,
      reason: String(req.body?.reason || '').trim(),
    });

    const populated = await ClassroomTransferRequest.findById(request._id)
      .populate('student', 'name')
      .populate('fromClassroom', 'name grade section')
      .populate('toClassroom', 'name grade section')
      .lean();

    return res
      .status(201)
      .json({ status: 'success', data: mapRequest(populated) });
  } catch (err) {
    if (err?.code === 11000) {
      return next(
        new AppError(
          'You already have a class change request waiting for approval.',
          409,
        ),
      );
    }
    throw err;
  }
});

// GET /api/v1/classroom-transfers/mine
exports.getMyTransferRequests = catchAsync(async (req, res, next) => {
  const requests = await ClassroomTransferRequest.find({
    student: req.user._id,
  })
    .populate('fromClassroom', 'name grade section')
    .populate('toClassroom', 'name grade section')
    .sort({ requestedAt: -1 })
    .lean();

  res.status(200).json({
    status: 'success',
    results: requests.length,
    data: requests.map(mapRequest),
  });
});

// PATCH /api/v1/classroom-transfers/:id/cancel
exports.cancelTransferRequest = catchAsync(async (req, res, next) => {
  const id = asObjectIdOrNull(req.params.id);
  if (!id) return next(new AppError('Request not found.', 404));

  const cancelled = await ClassroomTransferRequest.findOneAndUpdate(
    { _id: id, student: req.user._id, status: 'pending' },
    { $set: { status: 'cancelled', decidedAt: new Date() } },
    { new: true },
  );
  if (!cancelled) {
    return next(
      new AppError('This request has already been decided.', 409),
    );
  }

  res.status(200).json({ status: 'success', data: mapRequest(cancelled) });
});

/* ----------------------------------------------------------------- teacher */

// GET /api/v1/classroom-transfers  — requests out of classrooms I home-teach
exports.getIncomingTransferRequests = catchAsync(async (req, res, next) => {
  const page = parsePositiveInt(req.query.page, 1);
  const limit = parsePositiveInt(req.query.limit, 25, 50);
  const status = ['pending', 'approved', 'rejected', 'cancelled'].includes(
    req.query.status,
  )
    ? req.query.status
    : 'pending';

  const classroomIds = await approvableClassroomIds(req.user);

  if (!classroomIds.length) {
    return res.status(200).json({
      status: 'success',
      results: 0,
      pagination: { page, limit, total: 0, totalPages: 1 },
      data: [],
    });
  }

  const filter = { fromClassroom: { $in: classroomIds }, status };
  const classroomId = asObjectIdOrNull(req.query.classroomId);
  if (classroomId) filter.fromClassroom = classroomId;

  const [requests, total] = await Promise.all([
    ClassroomTransferRequest.find(filter)
      .populate('student', 'name')
      .populate('fromClassroom', 'name grade section')
      .populate('toClassroom', 'name grade section')
      .sort({ requestedAt: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    ClassroomTransferRequest.countDocuments(filter),
  ]);

  res.status(200).json({
    status: 'success',
    results: requests.length,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
    data: requests.map(mapRequest),
  });
});

// PATCH /api/v1/classroom-transfers/:id
//
// No transaction is needed. Claiming the request is itself the mutex — a second
// approver loses at step 1 — and the move is a single-document $set on the student,
// guarded on their current classroom so a stale request cannot yank a student out
// of a class they have already left by another route.
exports.decideTransferRequest = catchAsync(async (req, res, next) => {
  const id = asObjectIdOrNull(req.params.id);
  if (!id) return next(new AppError('Request not found.', 404));

  const decision = String(req.body?.decision || '').trim();
  if (!['approved', 'rejected'].includes(decision)) {
    return next(
      new AppError("Decision must be 'approved' or 'rejected'.", 400),
    );
  }

  const note = String(req.body?.decisionNote || '').trim();
  if (decision === 'rejected' && note.length < 10) {
    return next(
      new AppError('Give the student a reason of at least 10 characters.', 400),
    );
  }

  const request = await ClassroomTransferRequest.findById(id).lean();
  if (!request) return next(new AppError('Request not found.', 404));
  if (request.status !== 'pending') {
    return res.status(409).json({
      status: 'fail',
      code: 'ALREADY_DECIDED',
      message: 'This request has already been decided.',
      data: { id: request._id, status: request.status },
    });
  }

  const fromClassroom = await Classroom.findById(request.fromClassroom);
  if (!fromClassroom) return next(new AppError('Classroom not found.', 404));

  const decidedByRole = await resolveApproverRole(fromClassroom, req.user);
  if (!decidedByRole) {
    return next(
      new AppError(
        'Only the home teacher of this classroom can decide this request.',
        403,
      ),
    );
  }

  const now = new Date();

  // 1. Claim the request. This is the mutex.
  const claimed = await ClassroomTransferRequest.findOneAndUpdate(
    { _id: id, status: 'pending' },
    {
      $set: {
        status: decision,
        decidedBy: req.user._id,
        decidedByRole,
        decidedAt: now,
        decisionNote: note,
      },
    },
    { new: true },
  );
  if (!claimed) {
    return res.status(409).json({
      status: 'fail',
      code: 'ALREADY_DECIDED',
      message: 'This request has already been decided.',
      data: { id },
    });
  }

  if (decision === 'approved') {
    // 2. Move the student — one atomic single-document update.
    const moved = await User.findOneAndUpdate(
      {
        _id: claimed.student,
        classroom: claimed.fromClassroom,
        role: 'user',
      },
      { $set: { classroom: claimed.toClassroom } },
      { new: true },
    )
      .select('_id classroom')
      .lean();

    if (!moved) {
      // Compensate: put the request back so it can be decided again.
      await ClassroomTransferRequest.updateOne(
        { _id: claimed._id },
        {
          $set: {
            status: 'pending',
            decidedBy: null,
            decidedByRole: null,
            decidedAt: null,
            decisionNote: '',
          },
        },
      );
      return next(
        new AppError('That student is no longer in this classroom.', 409),
      );
    }

    // 3. An open referral stays with the teacher who filed it — they observed the
    // student and should keep getting status updates. The new home teacher inherits
    // no visibility. Flag the move for the therapist; a mid-year class change is
    // itself signal.
    const toClassroom = await Classroom.findById(claimed.toClassroom)
      .select('name grade section')
      .lean();

    await Referral.updateMany(
      { student: claimed.student, openKey: { $type: 'string' } },
      {
        $set: {
          studentTransferredAt: now,
          studentClassroomAtTransfer: claimed.toClassroom,
          classroom: claimed.toClassroom,
          'classroomSnapshot.name': toClassroom?.name || '',
          'classroomSnapshot.grade': toClassroom?.grade || '',
          'classroomSnapshot.section': toClassroom?.section || '',
        },
      },
    );
  }

  const populated = await ClassroomTransferRequest.findById(claimed._id)
    .populate('student', 'name')
    .populate('fromClassroom', 'name grade section')
    .populate('toClassroom', 'name grade section')
    .lean();

  res.status(200).json({ status: 'success', data: mapRequest(populated) });
});

/* -------------------------------------------------------------------- admin */

// GET /api/v1/classroom-transfers/all — the unassigned-home-teacher backstop
exports.listAllTransferRequests = catchAsync(async (req, res, next) => {
  const filter = {};
  const organization = asObjectIdOrNull(req.query.organizationId);
  if (organization) filter.organization = organization;
  if (['pending', 'approved', 'rejected', 'cancelled'].includes(req.query.status)) {
    filter.status = req.query.status;
  }

  const requests = await ClassroomTransferRequest.find(filter)
    .populate('student', 'name email')
    .populate('fromClassroom', 'name grade section homeTeacher')
    .populate('toClassroom', 'name grade section')
    .sort({ requestedAt: 1 })
    .lean();

  res.status(200).json({
    status: 'success',
    results: requests.length,
    data: requests.map(mapRequest),
  });
});
