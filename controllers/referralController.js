const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');
const User = require('../models/userModel');
const Classroom = require('../models/classroomModel');
const Referral = require('../models/referralModel');
const { CONCERN_TAGS, URGENCY_RANK } = require('../models/referralModel');
const {
  asObjectIdOrNull,
  escapeRegex,
  requireOrganization,
  resolveTherapistOrgIds,
  ensureTeacherStudent,
  teacherClassroomIds,
} = require('../utils/orgScope');

const OPEN_STATUSES = ['pending', 'acknowledged', 'in_progress'];

const parsePositiveInt = (value, fallback, max) => {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return max ? Math.min(parsed, max) : parsed;
};

const classroomLabel = (snapshot) => {
  if (!snapshot) return '';
  if (snapshot.grade) {
    return snapshot.section
      ? `${snapshot.grade}-${snapshot.section}`
      : String(snapshot.grade);
  }
  return snapshot.name || '';
};

/* ----------------------------------------------------------------- mappers */

// What the referring teacher may read back. Deliberately omits closureNote and
// statusHistory[].note — that split is the entire reason closureSummaryForTeacher
// exists as a separate field. It also omits the claiming therapist's identity.
const mapReferralForTeacher = (referral) => ({
  id: referral._id,
  student: referral.student?._id
    ? { id: referral.student._id, name: referral.student.name }
    : { id: referral.student, name: '' },
  classroom: referral.classroom || null,
  classroomSnapshot: referral.classroomSnapshot,
  classroomLabel: classroomLabel(referral.classroomSnapshot),
  reason: referral.reason,
  concernTags: referral.concernTags || [],
  urgency: referral.urgency,
  status: referral.status,
  createdAt: referral.createdAt,
  updatedAt: referral.updatedAt,
  acknowledgedAt: referral.acknowledgedAt,
  startedAt: referral.startedAt,
  closedAt: referral.closedAt,
  closureOutcome: referral.closureOutcome || null,
  closureSummaryForTeacher: referral.closureSummaryForTeacher || '',
  studentTransferredAt: referral.studentTransferredAt || null,
  additionalNotes: (referral.additionalNotes || []).map((n) => ({
    note: n.note,
    at: n.at,
  })),
});

const mapReferralForTherapist = (referral) => ({
  id: referral._id,
  student: referral.student?._id
    ? { id: referral.student._id, name: referral.student.name }
    : { id: referral.student, name: '' },
  teacher: referral.teacher?._id
    ? { id: referral.teacher._id, name: referral.teacher.name }
    : null,
  source: referral.source || 'teacher_manual',
  selfAssessment:
    referral.source === 'self_assessment' ? referral.selfAssessment || null : null,
  organization: referral.organization,
  classroom: referral.classroom || null,
  classroomSnapshot: referral.classroomSnapshot,
  classroomLabel: classroomLabel(referral.classroomSnapshot),
  reason: referral.reason,
  concernTags: referral.concernTags || [],
  urgency: referral.urgency,
  urgencyRank: referral.urgencyRank,
  status: referral.status,
  assignedTherapist: referral.assignedTherapist?._id
    ? {
        id: referral.assignedTherapist._id,
        name: referral.assignedTherapist.name,
      }
    : null,
  createdAt: referral.createdAt,
  updatedAt: referral.updatedAt,
  acknowledgedAt: referral.acknowledgedAt,
  startedAt: referral.startedAt,
  closedAt: referral.closedAt,
  closureOutcome: referral.closureOutcome || null,
  closureNote: referral.closureNote || '',
  closureSummaryForTeacher: referral.closureSummaryForTeacher || '',
  statusHistory: referral.statusHistory || [],
  additionalNotes: referral.additionalNotes || [],
  studentTransferredAt: referral.studentTransferredAt || null,
});

/* ----------------------------------------------------------------- teacher */

// POST /api/v1/referrals
exports.createReferral = catchAsync(async (req, res, next) => {
  const organizationId = requireOrganization(req.user);
  const student = await ensureTeacherStudent({
    teacherId: req.user._id,
    studentId: req.body?.studentId,
  });

  const reason = String(req.body?.reason || '').trim();
  if (reason.length < 20) {
    return next(
      new AppError(
        'Describe what you have observed in at least 20 characters.',
        400,
      ),
    );
  }

  const urgency = ['low', 'medium', 'high'].includes(req.body?.urgency)
    ? req.body.urgency
    : 'medium';

  const concernTags = Array.isArray(req.body?.concernTags)
    ? [...new Set(req.body.concernTags.filter((t) => CONCERN_TAGS.includes(t)))]
    : [];
  if (!concernTags.length) {
    return next(new AppError('Pick at least one concern tag.', 400));
  }

  const classroom = await Classroom.findById(student.classroom)
    .select('name grade section')
    .lean();

  // Pre-flight so the client gets a structured 409 rather than the bare 500 an
  // unmapped E11000 would produce (errorController.js is never mounted).
  const existing = await Referral.findOne({
    organization: organizationId,
    openKey: String(student._id),
  })
    .select('_id status createdAt teacher source')
    .lean();

  if (existing) {
    const selfFlagged = existing.source === 'self_assessment';
    return res.status(409).json({
      status: 'fail',
      code: 'DUPLICATE_OPEN_REFERRAL',
      message: selfFlagged
        ? 'The help group already has an open case for this student.'
        : 'This student already has an open referral.',
      data: {
        // A self-flag is not the teacher's to open, so no id is handed back.
        referralId: selfFlagged ? null : existing._id,
        status: existing.status,
        createdAt: selfFlagged ? null : existing.createdAt,
        isMine: !selfFlagged && String(existing.teacher) === String(req.user._id),
      },
    });
  }

  let referral;
  try {
    referral = await Referral.create({
      student: student._id,
      teacher: req.user._id,
      organization: organizationId,
      classroom: student.classroom || null,
      classroomSnapshot: {
        name: classroom?.name || '',
        grade: classroom?.grade || '',
        section: classroom?.section || '',
      },
      reason,
      concernTags,
      urgency,
      observedSince: req.body?.observedSince
        ? new Date(req.body.observedSince)
        : null,
      statusHistory: [
        { status: 'pending', by: req.user._id, at: new Date(), note: '' },
      ],
    });
  } catch (err) {
    // Race backstop: two teachers filing for the same student at once.
    if (err?.code === 11000) {
      const clash = await Referral.findOne({
        organization: organizationId,
        openKey: String(student._id),
      })
        .select('_id status createdAt teacher source')
        .lean();
      const clashSelfFlagged = clash?.source === 'self_assessment';
      return res.status(409).json({
        status: 'fail',
        code: 'DUPLICATE_OPEN_REFERRAL',
        message: clashSelfFlagged
          ? 'The help group already has an open case for this student.'
          : 'This student already has an open referral.',
        data: {
          referralId: clashSelfFlagged ? null : clash?._id || null,
          status: clash?.status || null,
          isMine:
            !clashSelfFlagged && String(clash?.teacher || '') === String(req.user._id),
        },
      });
    }
    throw err;
  }

  referral.student = { _id: student._id, name: student.name };

  res.status(201).json({
    status: 'success',
    data: mapReferralForTeacher(referral),
  });
});

// GET /api/v1/referrals/mine
exports.getMyReferrals = catchAsync(async (req, res, next) => {
  const page = parsePositiveInt(req.query.page, 1);
  const limit = parsePositiveInt(req.query.limit, 20, 50);

  const filter = { teacher: req.user._id };
  const status = String(req.query.status || '').trim();
  if (status === 'open') {
    filter.openKey = { $type: 'string' };
  } else if (
    ['pending', 'acknowledged', 'in_progress', 'closed'].includes(status)
  ) {
    filter.status = status;
  }

  const [referrals, total, statusCounts] = await Promise.all([
    Referral.find(filter)
      .populate('student', 'name')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Referral.countDocuments(filter),
    Referral.aggregate([
      { $match: { teacher: req.user._id } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
  ]);

  const counts = statusCounts.reduce(
    (acc, row) => {
      acc[row._id] = row.count;
      return acc;
    },
    { pending: 0, acknowledged: 0, in_progress: 0, closed: 0 },
  );
  counts.open = counts.pending + counts.acknowledged + counts.in_progress;

  res.status(200).json({
    status: 'success',
    results: referrals.length,
    counts,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
    data: referrals.map(mapReferralForTeacher),
  });
});

// GET /api/v1/referrals/:id  (teacher variant — author only)
exports.getMyReferralById = catchAsync(async (req, res, next) => {
  const id = asObjectIdOrNull(req.params.id);
  if (!id) return next(new AppError('Referral not found.', 404));

  const referral = await Referral.findOne({ _id: id, teacher: req.user._id })
    .populate('student', 'name')
    .lean();
  if (!referral) return next(new AppError('Referral not found.', 404));

  await Referral.updateOne(
    { _id: id },
    { $set: { teacherLastViewedAt: new Date() } },
  );

  res
    .status(200)
    .json({ status: 'success', data: mapReferralForTeacher(referral) });
});

// POST /api/v1/referrals/:id/teacher-note
exports.addTeacherNote = catchAsync(async (req, res, next) => {
  const id = asObjectIdOrNull(req.params.id);
  if (!id) return next(new AppError('Referral not found.', 404));

  const note = String(req.body?.note || '').trim();
  if (!note) return next(new AppError('A note cannot be empty.', 400));

  const referral = await Referral.findById(id);
  if (!referral) return next(new AppError('Referral not found.', 404));
  // 404, not 403 — do not confirm to a teacher that a self-flag exists.
  if (referral.source === 'self_assessment') {
    return next(new AppError('Referral not found.', 404));
  }
  if (referral.status === 'closed') {
    return next(new AppError('This referral is closed.', 409));
  }

  // The author, or any teacher of the student's current classroom — so a second
  // teacher noticing the same child adds to one thread instead of opening another.
  const isAuthor = String(referral.teacher) === String(req.user._id);
  if (!isAuthor) {
    const classroomIds = await teacherClassroomIds(req.user._id);
    const student = await User.findById(referral.student)
      .select('classroom')
      .lean();
    const shares = classroomIds.some(
      (cid) => String(cid) === String(student?.classroom || ''),
    );
    if (!shares) return next(new AppError('Referral not found.', 404));
  }

  referral.additionalNotes.push({
    teacher: req.user._id,
    note,
    at: new Date(),
  });
  await referral.save();

  res
    .status(200)
    .json({ status: 'success', data: mapReferralForTeacher(referral) });
});

// PATCH /api/v1/referrals/:id/withdraw — author only, only while untouched.
exports.withdrawReferral = catchAsync(async (req, res, next) => {
  const id = asObjectIdOrNull(req.params.id);
  if (!id) return next(new AppError('Referral not found.', 404));

  const referral = await Referral.findOne({
    _id: id,
    teacher: req.user._id,
    status: 'pending',
  });
  if (!referral) {
    return next(
      new AppError(
        'This referral can no longer be withdrawn — the help group has already seen it.',
        409,
      ),
    );
  }

  referral.status = 'closed';
  referral.closureOutcome = 'withdrawn';
  referral.withdrawnAt = new Date();
  referral.closedAt = new Date();
  referral.statusHistory.push({
    status: 'closed',
    by: req.user._id,
    at: new Date(),
    note: 'Withdrawn by the referring teacher.',
  });
  await referral.save(); // pre('save') nulls openKey

  res
    .status(200)
    .json({ status: 'success', data: mapReferralForTeacher(referral) });
});

/* --------------------------------------------------------------- therapist */

// GET /api/v1/referrals/inbox
exports.getReferralInbox = catchAsync(async (req, res, next) => {
  const orgIds = await resolveTherapistOrgIds(req.user);

  const page = parsePositiveInt(req.query.page, 1);
  const limit = parsePositiveInt(req.query.limit, 20, 50);

  const filter = { organization: { $in: orgIds } };

  const status = String(req.query.status || 'open').trim();
  if (status === 'open') {
    filter.openKey = { $type: 'string' };
  } else if (
    ['pending', 'acknowledged', 'in_progress', 'closed'].includes(status)
  ) {
    filter.status = status;
  }

  if (['low', 'medium', 'high'].includes(req.query.urgency)) {
    filter.urgency = req.query.urgency;
  }

  const classroomId = asObjectIdOrNull(req.query.classroomId);
  if (classroomId) filter.classroom = classroomId;

  const claimed = String(req.query.claimed || '').trim();
  if (claimed === 'mine') filter.assignedTherapist = req.user._id;
  else if (claimed === 'unclaimed') filter.assignedTherapist = null;

  const search = String(req.query.search || '').trim();
  if (search) {
    const matches = await User.find({
      role: 'user',
      name: { $regex: escapeRegex(search), $options: 'i' },
    })
      .select('_id')
      .limit(200)
      .lean();
    filter.student = { $in: matches.map((m) => m._id) };
  }

  const [referrals, total] = await Promise.all([
    Referral.find(filter)
      .populate('student', 'name')
      .populate('teacher', 'name')
      .populate('assignedTherapist', 'name')
      .sort({ urgencyRank: -1, createdAt: 1 }) // urgent first, then longest-waiting
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Referral.countDocuments(filter),
  ]);

  res.status(200).json({
    status: 'success',
    results: referrals.length,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
    data: referrals.map(mapReferralForTherapist),
  });
});

// GET /api/v1/referrals/inbox/counts
exports.getReferralInboxCounts = catchAsync(async (req, res, next) => {
  const orgIds = await resolveTherapistOrgIds(req.user);

  const rows = await Referral.aggregate([
    { $match: { organization: { $in: orgIds } } },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        urgent: {
          $sum: { $cond: [{ $eq: ['$urgency', 'high'] }, 1, 0] },
        },
        unclaimed: {
          $sum: { $cond: [{ $eq: ['$assignedTherapist', null] }, 1, 0] },
        },
      },
    },
  ]);

  const counts = {
    pending: 0,
    acknowledged: 0,
    in_progress: 0,
    closed: 0,
    urgentOpen: 0,
    unclaimed: 0,
  };
  rows.forEach((row) => {
    counts[row._id] = row.count;
    if (OPEN_STATUSES.includes(row._id)) {
      counts.urgentOpen += row.urgent;
      counts.unclaimed += row.unclaimed;
    }
  });
  counts.open = counts.pending + counts.acknowledged + counts.in_progress;

  res.status(200).json({ status: 'success', data: counts });
});

// GET /api/v1/referrals/inbox/:id
exports.getReferralForTherapist = catchAsync(async (req, res, next) => {
  const orgIds = await resolveTherapistOrgIds(req.user);
  const id = asObjectIdOrNull(req.params.id);
  if (!id) return next(new AppError('Referral not found.', 404));

  const referral = await Referral.findOne({
    _id: id,
    organization: { $in: orgIds },
  })
    .populate('student', 'name')
    .populate('teacher', 'name')
    .populate('assignedTherapist', 'name');

  if (!referral) return next(new AppError('Referral not found.', 404));

  if (!referral.therapistFirstViewedAt) {
    referral.therapistFirstViewedAt = new Date();
    await referral.save();
  }

  res
    .status(200)
    .json({ status: 'success', data: mapReferralForTherapist(referral) });
});

// PATCH /api/v1/referrals/:id/claim
//
// The guarded findOneAndUpdate is the mutex — a second therapist claiming the same
// referral loses here and gets a structured 409 naming who won, rather than
// silently overwriting the first claim.
exports.claimReferral = catchAsync(async (req, res, next) => {
  const orgIds = await resolveTherapistOrgIds(req.user);
  const id = asObjectIdOrNull(req.params.id);
  if (!id) return next(new AppError('Referral not found.', 404));

  const now = new Date();
  const claimed = await Referral.findOneAndUpdate(
    {
      _id: id,
      organization: { $in: orgIds },
      status: 'pending',
      assignedTherapist: null,
    },
    {
      $set: {
        assignedTherapist: req.user._id,
        status: 'acknowledged',
        acknowledgedAt: now,
      },
      $push: {
        statusHistory: { status: 'acknowledged', by: req.user._id, at: now },
      },
    },
    { new: true },
  );

  if (!claimed) {
    const current = await Referral.findOne({
      _id: id,
      organization: { $in: orgIds },
    })
      .populate('assignedTherapist', 'name')
      .lean();

    if (!current) return next(new AppError('Referral not found.', 404));

    return res.status(409).json({
      status: 'fail',
      code: 'ALREADY_CLAIMED',
      message: current.assignedTherapist
        ? `${current.assignedTherapist.name} has already claimed this referral.`
        : 'This referral is no longer pending.',
      data: mapReferralForTherapist(current),
    });
  }

  // Claiming binds the student to this therapist, which is what makes the existing
  // assignedTherapist-gated clinical endpoints work. Guarded so it can never steal
  // a student who already has a different therapist.
  const student = await User.findById(claimed.student);
  if (student) {
    if (
      student.assignedTherapist &&
      String(student.assignedTherapist) !== String(req.user._id)
    ) {
      return res.status(409).json({
        status: 'fail',
        code: 'STUDENT_ALREADY_ASSIGNED',
        message:
          'This student already has a different assigned therapist. Close this referral as a duplicate or ask an admin to reassign.',
        data: mapReferralForTherapist(claimed),
      });
    }
    student.assignedTherapist = req.user._id;
    // Deliberately NOT touching hasSelectedOrgTherapist: "assigned via referral"
    // must stay distinguishable from "chosen by the student".
    await student.save({ validateBeforeSave: false });
  }

  const populated = await Referral.findById(claimed._id)
    .populate('student', 'name')
    .populate('teacher', 'name')
    .populate('assignedTherapist', 'name')
    .lean();

  res
    .status(200)
    .json({ status: 'success', data: mapReferralForTherapist(populated) });
});

const ALLOWED_TRANSITIONS = {
  pending: ['acknowledged', 'closed'],
  acknowledged: ['in_progress', 'closed'],
  in_progress: ['closed'],
  closed: [],
};

// PATCH /api/v1/referrals/:id/status
exports.updateReferralStatus = catchAsync(async (req, res, next) => {
  const orgIds = await resolveTherapistOrgIds(req.user);
  const id = asObjectIdOrNull(req.params.id);
  if (!id) return next(new AppError('Referral not found.', 404));

  const referral = await Referral.findOne({
    _id: id,
    organization: { $in: orgIds },
  });
  if (!referral) return next(new AppError('Referral not found.', 404));

  const isClaimer =
    String(referral.assignedTherapist || '') === String(req.user._id);
  const isAdmin =
    req.user.role === 'admin' || (req.user.roles || []).includes('admin');
  if (!isClaimer && !isAdmin) {
    return next(
      new AppError('Claim this referral before changing its status.', 403),
    );
  }

  const nextStatus = String(req.body?.status || '').trim();
  const allowed = ALLOWED_TRANSITIONS[referral.status] || [];
  if (!allowed.includes(nextStatus)) {
    return next(
      new AppError(
        `Cannot move a ${referral.status} referral to ${nextStatus || 'that status'}. Allowed: ${allowed.join(', ') || 'none'}.`,
        400,
      ),
    );
  }

  const now = new Date();
  referral.status = nextStatus;
  if (nextStatus === 'acknowledged') referral.acknowledgedAt = now;
  if (nextStatus === 'in_progress') referral.startedAt = now;
  if (nextStatus === 'closed') {
    referral.closedAt = now;
    const outcome = String(req.body?.closureOutcome || '').trim();
    if (outcome) referral.closureOutcome = outcome;
    if (req.body?.closureNote !== undefined) {
      referral.closureNote = String(req.body.closureNote || '').trim();
    }
    if (req.body?.closureSummaryForTeacher !== undefined) {
      referral.closureSummaryForTeacher = String(
        req.body.closureSummaryForTeacher || '',
      ).trim();
    }
  }

  referral.statusHistory.push({
    status: nextStatus,
    by: req.user._id,
    at: now,
    note: String(req.body?.note || '').trim(),
  });

  await referral.save(); // pre('save') maintains openKey

  const populated = await Referral.findById(referral._id)
    .populate('student', 'name')
    .populate('teacher', 'name')
    .populate('assignedTherapist', 'name')
    .lean();

  res
    .status(200)
    .json({ status: 'success', data: mapReferralForTherapist(populated) });
});

module.exports.mapReferralForTeacher = mapReferralForTeacher;
module.exports.mapReferralForTherapist = mapReferralForTherapist;
module.exports.URGENCY_RANK = URGENCY_RANK;
