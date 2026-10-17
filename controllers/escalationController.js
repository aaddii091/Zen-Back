const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');
const User = require('../models/userModel');
const Classroom = require('../models/classroomModel');
const Referral = require('../models/referralModel');
const Escalation = require('../models/escalationModel');
const {
  asObjectIdOrNull,
  requireSchoolAdminOrg,
} = require('../utils/orgScope');
const { recordAccess } = require('../utils/accessLog');

const { STATUSES, OPEN_STATUSES, CONTACT_METHODS, URGENCY_RANK } = Escalation;

const parsePositiveInt = (value, fallback, max = 100) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
};

/* ------------------------------------------------------------- projections */

// What the counsellor who raised it may read back. adminNotes and the
// statusHistory notes are absent by construction, not filtered out later — the
// admin's record of a parent conversation is not the counsellor's to read.
const mapForCounsellor = (escalation) => ({
  id: escalation._id,
  student: {
    id: escalation.student?._id || escalation.student,
    name: escalation.student?.name || '',
  },
  classroomSnapshot: escalation.classroomSnapshot || {},
  status: escalation.status,
  urgency: escalation.urgency,
  reason: escalation.reason,
  referralId: escalation.referral || null,
  summaryForCounsellor: escalation.summaryForCounsellor || '',
  parentContacted: Boolean(escalation.parentContact?.contactedAt),
  parentContactedAt: escalation.parentContact?.contactedAt || null,
  acknowledgedAt: escalation.acknowledgedAt,
  closedAt: escalation.closedAt,
  createdAt: escalation.createdAt,
  updatedAt: escalation.updatedAt,
});

const mapForAdmin = (escalation) => ({
  ...mapForCounsellor(escalation),
  counsellor: {
    id: escalation.counsellor?._id || escalation.counsellor,
    name: escalation.counsellor?.name || '',
  },
  adminNotes: escalation.adminNotes || '',
  parentContact: {
    contactedAt: escalation.parentContact?.contactedAt || null,
    method: escalation.parentContact?.method || null,
    byAdmin: escalation.parentContact?.byAdmin || null,
    outcome: escalation.parentContact?.outcome || '',
  },
  statusHistory: escalation.statusHistory || [],
  accessLog: (escalation.accessLog || []).map((entry) => ({
    viewer: entry.viewer,
    viewerRole: entry.viewerRole,
    at: entry.at,
  })),
});

/* ------------------------------------------------------------------ access */

// A counsellor may only escalate a student who is actually assigned to them.
// Same rule ensureTherapistClientAccess enforces for notes and chat; duplicated
// here rather than imported because authController does not export it.
const ensureOwnClient = async ({ counsellorId, studentId }) => {
  const id = asObjectIdOrNull(studentId);
  if (!id) throw new AppError('Student not found.', 404);

  const student = await User.findById(id)
    .select('name role organization classroom assignedTherapist')
    .lean();

  if (!student || student.role !== 'user') {
    throw new AppError('Student not found.', 404);
  }
  if (
    !student.assignedTherapist ||
    String(student.assignedTherapist) !== String(counsellorId)
  ) {
    throw new AppError('This student is not assigned to you.', 403);
  }
  if (!student.organization) {
    throw new AppError(
      'This student is not linked to a school, so there is no admin to escalate to.',
      400,
    );
  }
  return student;
};

/* -------------------------------------------------------------- counsellor */

// POST /api/v1/escalations
exports.createEscalation = catchAsync(async (req, res, next) => {
  const student = await ensureOwnClient({
    counsellorId: req.user._id,
    studentId: req.body?.studentId,
  });

  const reason = String(req.body?.reason || '').trim();
  if (reason.length < 20) {
    return next(
      new AppError(
        'Describe why this needs the school’s attention in at least 20 characters.',
        400,
      ),
    );
  }

  const urgency = ['low', 'medium', 'high'].includes(req.body?.urgency)
    ? req.body.urgency
    : 'medium';

  const classroom = student.classroom
    ? await Classroom.findById(student.classroom)
        .select('name grade section')
        .lean()
    : null;

  // Pre-flight so the client gets a structured 409 rather than the bare 500 an
  // unmapped E11000 would produce (errorController.js is never mounted).
  const existing = await Escalation.findOne({
    organization: student.organization,
    openKey: String(student._id),
  })
    .select('_id status createdAt counsellor')
    .lean();

  if (existing) {
    return res.status(409).json({
      status: 'fail',
      code: 'DUPLICATE_OPEN_ESCALATION',
      message: 'This student already has an open escalation with the school.',
      data: {
        escalationId: existing._id,
        status: existing.status,
        createdAt: existing.createdAt,
        isMine: String(existing.counsellor) === String(req.user._id),
      },
    });
  }

  let referralId = null;
  if (req.body?.referralId) {
    const linked = await Referral.findOne({
      _id: asObjectIdOrNull(req.body.referralId),
      student: student._id,
      organization: student.organization,
    })
      .select('_id')
      .lean();
    referralId = linked?._id || null;
  }

  let escalation;
  try {
    escalation = await Escalation.create({
      student: student._id,
      counsellor: req.user._id,
      organization: student.organization,
      referral: referralId,
      classroomSnapshot: {
        name: classroom?.name || '',
        grade: classroom?.grade || '',
        section: classroom?.section || '',
      },
      reason,
      urgency,
      statusHistory: [{ status: 'pending', by: req.user._id, at: new Date() }],
    });
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({
        status: 'fail',
        code: 'DUPLICATE_OPEN_ESCALATION',
        message: 'This student already has an open escalation with the school.',
      });
    }
    throw err;
  }

  await escalation.populate('student', 'name');

  res.status(201).json({
    status: 'success',
    data: mapForCounsellor(escalation),
  });
});

// GET /api/v1/escalations/mine
exports.getMyEscalations = catchAsync(async (req, res) => {
  const page = parsePositiveInt(req.query.page, 1, 1000);
  const limit = parsePositiveInt(req.query.limit, 20, 100);

  const filter = { counsellor: req.user._id };
  if (STATUSES.includes(req.query.status)) filter.status = req.query.status;

  const [items, total] = await Promise.all([
    Escalation.find(filter)
      .populate('student', 'name')
      .sort({ urgencyRank: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Escalation.countDocuments(filter),
  ]);

  res.status(200).json({
    status: 'success',
    results: items.length,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
    data: items.map(mapForCounsellor),
  });
});

/* ------------------------------------------------------------ school admin */

// GET /api/v1/escalations/inbox
exports.getEscalationInbox = catchAsync(async (req, res) => {
  const organizationId = requireSchoolAdminOrg(req.user);

  const page = parsePositiveInt(req.query.page, 1, 1000);
  const limit = parsePositiveInt(req.query.limit, 20, 100);

  const filter = { organization: organizationId };
  if (STATUSES.includes(req.query.status)) {
    filter.status = req.query.status;
  } else if (req.query.status === 'open') {
    filter.status = { $in: OPEN_STATUSES };
  }

  const [items, total] = await Promise.all([
    Escalation.find(filter)
      .populate('student', 'name')
      .populate('counsellor', 'name')
      .sort({ urgencyRank: -1, createdAt: 1 }) // urgent first, then longest-waiting
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Escalation.countDocuments(filter),
  ]);

  res.status(200).json({
    status: 'success',
    results: items.length,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
    data: items.map(mapForAdmin),
  });
});

// GET /api/v1/escalations/inbox/counts
exports.getEscalationCounts = catchAsync(async (req, res) => {
  const organizationId = requireSchoolAdminOrg(req.user);

  const rows = await Escalation.aggregate([
    { $match: { organization: organizationId } },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        urgent: { $sum: { $cond: [{ $eq: ['$urgency', 'high'] }, 1, 0] } },
      },
    },
  ]);

  const counts = {
    pending: 0,
    acknowledged: 0,
    parent_contacted: 0,
    closed: 0,
    urgentOpen: 0,
  };
  rows.forEach((row) => {
    counts[row._id] = row.count;
    if (OPEN_STATUSES.includes(row._id)) counts.urgentOpen += row.urgent;
  });
  counts.open =
    counts.pending + counts.acknowledged + counts.parent_contacted;

  res.status(200).json({ status: 'success', data: counts });
});

// GET /api/v1/escalations/inbox/:id
exports.getEscalationForAdmin = catchAsync(async (req, res, next) => {
  const organizationId = requireSchoolAdminOrg(req.user);
  const id = asObjectIdOrNull(req.params.id);
  if (!id) return next(new AppError('Escalation not found.', 404));

  const escalation = await Escalation.findOne({
    _id: id,
    organization: organizationId,
  })
    .populate('student', 'name')
    .populate('counsellor', 'name')
    .lean();

  if (!escalation) return next(new AppError('Escalation not found.', 404));

  await recordAccess(Escalation, escalation._id, req.user);

  res.status(200).json({ status: 'success', data: mapForAdmin(escalation) });
});

// PATCH /api/v1/escalations/:id/status
exports.updateEscalationStatus = catchAsync(async (req, res, next) => {
  const organizationId = requireSchoolAdminOrg(req.user);
  const id = asObjectIdOrNull(req.params.id);
  if (!id) return next(new AppError('Escalation not found.', 404));

  const status = String(req.body?.status || '').trim();
  if (!STATUSES.includes(status)) {
    return next(
      new AppError(`status must be one of: ${STATUSES.join(', ')}.`, 400),
    );
  }

  const escalation = await Escalation.findOne({
    _id: id,
    organization: organizationId,
  });
  if (!escalation) return next(new AppError('Escalation not found.', 404));

  escalation.status = status;
  if (status === 'acknowledged' && !escalation.acknowledgedAt) {
    escalation.acknowledgedAt = new Date();
  }
  if (status === 'closed') {
    escalation.closedAt = new Date();
  }

  if (req.body?.summaryForCounsellor !== undefined) {
    escalation.summaryForCounsellor = String(
      req.body.summaryForCounsellor || '',
    ).trim();
  }
  if (req.body?.adminNotes !== undefined) {
    escalation.adminNotes = String(req.body.adminNotes || '').trim();
  }

  escalation.statusHistory.push({
    status,
    by: req.user._id,
    at: new Date(),
    note: String(req.body?.note || '').trim(),
  });

  await escalation.save(); // .save() so the openKey hook fires
  await escalation.populate([
    { path: 'student', select: 'name' },
    { path: 'counsellor', select: 'name' },
  ]);

  res.status(200).json({ status: 'success', data: mapForAdmin(escalation) });
});

// POST /api/v1/escalations/:id/parent-contact
exports.recordParentContact = catchAsync(async (req, res, next) => {
  const organizationId = requireSchoolAdminOrg(req.user);
  const id = asObjectIdOrNull(req.params.id);
  if (!id) return next(new AppError('Escalation not found.', 404));

  const method = String(req.body?.method || '').trim();
  if (!CONTACT_METHODS.includes(method)) {
    return next(
      new AppError(`method must be one of: ${CONTACT_METHODS.join(', ')}.`, 400),
    );
  }

  const escalation = await Escalation.findOne({
    _id: id,
    organization: organizationId,
  });
  if (!escalation) return next(new AppError('Escalation not found.', 404));

  escalation.parentContact = {
    contactedAt: new Date(),
    method,
    byAdmin: req.user._id,
    outcome: String(req.body?.outcome || '').trim(),
  };

  // Recording contact advances the case unless it is already closed.
  if (escalation.status !== 'closed') {
    escalation.status = 'parent_contacted';
    escalation.statusHistory.push({
      status: 'parent_contacted',
      by: req.user._id,
      at: new Date(),
      note: String(req.body?.note || '').trim(),
    });
  }

  if (req.body?.summaryForCounsellor !== undefined) {
    escalation.summaryForCounsellor = String(
      req.body.summaryForCounsellor || '',
    ).trim();
  }

  await escalation.save();
  await escalation.populate([
    { path: 'student', select: 'name' },
    { path: 'counsellor', select: 'name' },
  ]);

  res.status(200).json({ status: 'success', data: mapForAdmin(escalation) });
});

module.exports.URGENCY_RANK = URGENCY_RANK;
