const mongoose = require('mongoose');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const User = require('../models/userModel');
const TherapistSessionReport = require('../models/therapistSessionReportModel');

const asObjectIdOrNull = (value) => {
  const raw = String(value || '').trim();
  if (!raw || !mongoose.Types.ObjectId.isValid(raw)) return null;
  return new mongoose.Types.ObjectId(raw);
};

const parseDateOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
};

const toMinuteBucket = (date) => {
  if (!date) return null;
  const bucket = new Date(date);
  bucket.setSeconds(0, 0);
  return bucket;
};

const normalizeTextField = (value) =>
  String(value || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .trim();

const mapReportPayload = (report) => ({
  id: report?._id,
  therapistId: report?.therapist?._id || report?.therapist || null,
  userId: report?.user?._id || report?.user || null,
  user: {
    id: report?.user?._id || report?.user || null,
    name: report?.user?.name || '',
    email: report?.user?.email || '',
  },
  appointmentRef: report?.appointmentRef || '',
  status: report?.status || 'draft',
  subjective: report?.subjective || '',
  objective: report?.objective || '',
  assessment: report?.assessment || '',
  plan: report?.plan || '',
  sessionAt: report?.sessionAt || null,
  submittedAt: report?.submittedAt || null,
  createdAt: report?.createdAt || null,
  updatedAt: report?.updatedAt || null,
});

const ensureTherapistClientAccess = async ({ therapistId, clientId }) => {
  const clientObjectId = asObjectIdOrNull(clientId);
  if (!clientObjectId) {
    throw new AppError('Invalid userId.', 400);
  }

  const client = await User.findById(clientObjectId)
    .select('name email role assignedTherapist')
    .lean();

  if (!client || client.role !== 'user') {
    throw new AppError('Client not found.', 404);
  }

  if (!client.assignedTherapist || String(client.assignedTherapist) !== String(therapistId)) {
    throw new AppError('This client is not assigned to this therapist.', 403);
  }

  return client;
};

const resolveLookup = ({ therapistId, userId, appointmentRef, sessionAt }) => {
  const userObjectId = asObjectIdOrNull(userId);
  if (!userObjectId) {
    throw new AppError('Invalid userId.', 400);
  }

  const normalizedAppointmentRef = String(appointmentRef || '').trim();
  const parsedSessionAt = parseDateOrNull(sessionAt);
  const sessionAtBucket = parsedSessionAt ? toMinuteBucket(parsedSessionAt) : null;

  if (!normalizedAppointmentRef && !sessionAtBucket) {
    throw new AppError('appointmentRef or sessionAt is required.', 400);
  }

  const filter = {
    therapist: therapistId,
    user: userObjectId,
  };

  if (normalizedAppointmentRef) {
    filter.appointmentRef = normalizedAppointmentRef;
  } else {
    filter.sessionAtBucket = sessionAtBucket;
  }

  return {
    userObjectId,
    parsedSessionAt,
    sessionAtBucket,
    normalizedAppointmentRef,
    filter,
  };
};

exports.createOrUpsertReport = catchAsync(async (req, res, next) => {
  if (req.user?.role !== 'therapist') {
    return next(new AppError('Only therapists can create session reports.', 403));
  }

  const {
    userId,
    appointmentRef,
    sessionAt,
    status,
    subjective,
    objective,
    assessment,
    plan,
  } = req.body || {};

  const {
    userObjectId,
    parsedSessionAt,
    sessionAtBucket,
    normalizedAppointmentRef,
    filter,
  } = resolveLookup({
    therapistId: req.user._id,
    userId,
    appointmentRef,
    sessionAt,
  });

  await ensureTherapistClientAccess({ therapistId: req.user._id, clientId: userObjectId });

  const desiredStatus = String(status || 'draft').trim().toLowerCase();
  if (!['draft', 'submitted'].includes(desiredStatus)) {
    return next(new AppError('status must be either draft or submitted.', 400));
  }

  const updateDoc = {
    subjective: normalizeTextField(subjective),
    objective: normalizeTextField(objective),
    assessment: normalizeTextField(assessment),
    plan: normalizeTextField(plan),
    status: desiredStatus,
  };

  if (parsedSessionAt) {
    updateDoc.sessionAt = parsedSessionAt;
    updateDoc.sessionAtBucket = sessionAtBucket;
  }

  if (normalizedAppointmentRef) {
    updateDoc.appointmentRef = normalizedAppointmentRef;
  }

  const existing = await TherapistSessionReport.findOne(filter);
  if (existing?.status === 'submitted') {
    return next(new AppError('Submitted reports are read-only.', 400));
  }

  if (desiredStatus === 'submitted') {
    updateDoc.submittedAt = new Date();
  } else {
    updateDoc.submittedAt = null;
  }

  const report = await TherapistSessionReport.findOneAndUpdate(
    filter,
    {
      $set: updateDoc,
      $setOnInsert: {
        therapist: req.user._id,
        user: userObjectId,
      },
    },
    {
      new: true,
      upsert: true,
      runValidators: true,
      setDefaultsOnInsert: true,
    },
  )
    .populate('user', 'name email')
    .lean();

  res.status(existing ? 200 : 201).json({
    status: 'success',
    data: {
      report: mapReportPayload(report),
    },
  });
});

exports.updateReport = catchAsync(async (req, res, next) => {
  if (req.user?.role !== 'therapist') {
    return next(new AppError('Only therapists can update session reports.', 403));
  }

  const reportId = asObjectIdOrNull(req.params?.id);
  if (!reportId) {
    return next(new AppError('Invalid report id.', 400));
  }

  const report = await TherapistSessionReport.findOne({
    _id: reportId,
    therapist: req.user._id,
  });

  if (!report) {
    return next(new AppError('Session report not found.', 404));
  }

  await ensureTherapistClientAccess({ therapistId: req.user._id, clientId: report.user });

  if (report.status === 'submitted') {
    return next(new AppError('Submitted reports are read-only.', 400));
  }

  const allowedFields = ['subjective', 'objective', 'assessment', 'plan'];
  allowedFields.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(req.body || {}, field)) {
      report[field] = normalizeTextField(req.body[field]);
    }
  });

  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'sessionAt')) {
    const parsedSessionAt = parseDateOrNull(req.body.sessionAt);
    if (!parsedSessionAt) {
      return next(new AppError('Invalid sessionAt date.', 400));
    }
    report.sessionAt = parsedSessionAt;
    report.sessionAtBucket = toMinuteBucket(parsedSessionAt);
  }

  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'appointmentRef')) {
    report.appointmentRef = String(req.body.appointmentRef || '').trim();
  }

  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'status')) {
    const status = String(req.body.status || '').trim().toLowerCase();
    if (!['draft', 'submitted'].includes(status)) {
      return next(new AppError('status must be either draft or submitted.', 400));
    }
    report.status = status;
    report.submittedAt = status === 'submitted' ? new Date() : null;
  }

  await report.save({ validateBeforeSave: true });

  const hydrated = await TherapistSessionReport.findById(report._id)
    .populate('user', 'name email')
    .lean();

  res.status(200).json({
    status: 'success',
    data: {
      report: mapReportPayload(hydrated),
    },
  });
});

exports.getReports = catchAsync(async (req, res, next) => {
  if (req.user?.role !== 'therapist') {
    return next(new AppError('Only therapists can access session reports.', 403));
  }

  const userIdRaw = String(req.query?.userId || '').trim();
  const appointmentRef = String(req.query?.appointmentRef || '').trim();
  const status = String(req.query?.status || '').trim().toLowerCase();
  const sessionAt = parseDateOrNull(req.query?.sessionAt);

  const filter = {
    therapist: req.user._id,
  };

  if (userIdRaw) {
    const userObjectId = asObjectIdOrNull(userIdRaw);
    if (!userObjectId) {
      return next(new AppError('Invalid userId.', 400));
    }
    await ensureTherapistClientAccess({ therapistId: req.user._id, clientId: userObjectId });
    filter.user = userObjectId;
  }

  if (appointmentRef) {
    filter.appointmentRef = appointmentRef;
  }

  if (sessionAt) {
    filter.sessionAtBucket = toMinuteBucket(sessionAt);
  }

  if (status) {
    if (!['draft', 'submitted'].includes(status)) {
      return next(new AppError('Invalid status filter.', 400));
    }
    filter.status = status;
  }

  const reports = await TherapistSessionReport.find(filter)
    .populate('user', 'name email')
    .sort({ sessionAt: -1, createdAt: -1 })
    .lean();

  const data = reports.map(mapReportPayload);

  res.status(200).json({
    status: 'success',
    results: data.length,
    data,
  });
});

exports.getReportById = catchAsync(async (req, res, next) => {
  if (req.user?.role !== 'therapist') {
    return next(new AppError('Only therapists can access session reports.', 403));
  }

  const reportId = asObjectIdOrNull(req.params?.id);
  if (!reportId) {
    return next(new AppError('Invalid report id.', 400));
  }

  const report = await TherapistSessionReport.findOne({
    _id: reportId,
    therapist: req.user._id,
  })
    .populate('user', 'name email assignedTherapist role')
    .lean();

  if (!report) {
    return next(new AppError('Session report not found.', 404));
  }

  if (
    !report?.user ||
    report?.user?.role !== 'user' ||
    String(report?.user?.assignedTherapist || '') !== String(req.user._id)
  ) {
    return next(new AppError('This client is not assigned to this therapist.', 403));
  }

  res.status(200).json({
    status: 'success',
    data: {
      report: mapReportPayload(report),
    },
  });
});
