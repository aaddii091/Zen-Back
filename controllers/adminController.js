const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const mongoose = require('mongoose');

const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');
const User = require('../models/userModel');
const Organization = require('../models/organizationModel');
const AdminAuditLog = require('../models/adminAuditLogModel');
const StudentImportJob = require('../models/studentImportJobModel');

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const name = String(file?.originalname || '').toLowerCase();
    if (name.endsWith('.csv')) return cb(null, true);
    return cb(new AppError('Only CSV files are allowed.', 400), false);
  },
  limits: { fileSize: 3 * 1024 * 1024 },
});

const escapeRegex = (value = '') =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const parsePositiveInt = (value, fallback, { min = 1, max = 100 } = {}) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return Math.min(parsed, max);
};

const normalizeSortDirection = (value) =>
  String(value || '').toLowerCase() === 'asc' ? 1 : -1;

const generateJoinCode = () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
};

const generateOrganizationLegacyId = () =>
  `ORG-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

const signAdminToken = (payload) =>
  jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: '15m',
  });

const sanitizeUserForAudit = (userDoc) => {
  if (!userDoc) return null;
  const plain = typeof userDoc.toObject === 'function' ? userDoc.toObject() : userDoc;
  const safe = { ...plain };
  delete safe.password;
  delete safe.passwordConfirm;
  delete safe.passwordResetToken;
  delete safe.passwordResetExpires;
  return safe;
};

const writeAuditLog = async ({ req, actionType, targetType, targetId, reason = '', before = null, after = null }) => {
  try {
    await AdminAuditLog.create({
      actor: {
        id: req.user?._id,
        email: req.user?.email || '',
        name: req.user?.name || '',
      },
      actionType,
      targetType,
      targetId: String(targetId || ''),
      reason: String(reason || '').trim(),
      before,
      after,
      requestMeta: {
        ip: req.ip || '',
        method: req.method || '',
        path: req.originalUrl || '',
        userAgent: req.get('user-agent') || '',
      },
    });
  } catch (error) {
    console.error('Admin audit write failed:', error?.message || error);
  }
};

const parseCsv = (buffer) => {
  const text = String(buffer || '').replace(/^\uFEFF/, '');
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) {
    throw new AppError('CSV file is empty.', 400);
  }

  const headers = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const emailIdx = headers.indexOf('email');
  const nameIdx = headers.indexOf('name');

  if (emailIdx < 0 || nameIdx < 0) {
    throw new AppError('CSV must include name and email columns.', 400);
  }

  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cols = lines[i].split(',').map((c) => c.trim());
    rows.push({
      rowNumber: i + 1,
      name: cols[nameIdx] || '',
      email: (cols[emailIdx] || '').toLowerCase(),
    });
  }
  return rows;
};

const getOrgStudentCount = async (organizationId) => {
  if (!organizationId) return 0;
  return User.countDocuments({ organization: organizationId, role: 'user' });
};

const getOrgOnboardedStudentCount = async (organizationId) => {
  if (!organizationId) return 0;
  return User.countDocuments({
    organization: organizationId,
    role: 'user',
    hasOnboarded: true,
  });
};

const buildOrgMetrics = async (orgIds = []) => {
  if (!orgIds.length) {
    return { totalMap: new Map(), onboardedMap: new Map() };
  }

  const [studentCounts, onboardedCounts] = await Promise.all([
    User.aggregate([
      { $match: { organization: { $in: orgIds }, role: 'user' } },
      { $group: { _id: '$organization', count: { $sum: 1 } } },
    ]),
    User.aggregate([
      {
        $match: {
          organization: { $in: orgIds },
          role: 'user',
          hasOnboarded: true,
        },
      },
      { $group: { _id: '$organization', count: { $sum: 1 } } },
    ]),
  ]);

  return {
    totalMap: new Map(studentCounts.map((row) => [String(row._id), Number(row.count || 0)])),
    onboardedMap: new Map(onboardedCounts.map((row) => [String(row._id), Number(row.count || 0)])),
  };
};

const processStudentImportJob = async (jobId) => {
  const job = await StudentImportJob.findById(jobId).select('+_csvPayload');
  if (!job) return;

  const csvData = job._csvPayload || '';
  if (!csvData) {
    job.status = 'failed';
    job.errorMessage = 'CSV payload missing.';
    job.completedAt = new Date();
    await job.save({ validateBeforeSave: false });
    return;
  }

  job.status = 'processing';
  job.startedAt = new Date();
  await job.save({ validateBeforeSave: false });

  try {
    const rows = parseCsv(csvData);
    const results = [];
    let createdCount = 0;
    let failedCount = 0;

    const org = await Organization.findById(job.organization)
      .select('studentCap organizationName')
      .lean();

    for (const row of rows) {
      const email = String(row.email || '').trim().toLowerCase();
      const name = String(row.name || '').trim();

      if (!email || !name) {
        failedCount += 1;
        results.push({
          rowNumber: row.rowNumber,
          email,
          name,
          status: 'failed',
          message: 'Missing name or email.',
          userId: null,
        });
        continue;
      }

      const existing = await User.findOne({ email }).select('_id').lean();
      if (existing) {
        failedCount += 1;
        results.push({
          rowNumber: row.rowNumber,
          email,
          name,
          status: 'failed',
          message: 'Email already exists.',
          userId: existing._id,
        });
        continue;
      }

      if (org && Number(org.studentCap || 0) > 0) {
        const currentCount = await getOrgStudentCount(job.organization);
        if (currentCount >= Number(org.studentCap || 0)) {
          failedCount += 1;
          results.push({
            rowNumber: row.rowNumber,
            email,
            name,
            status: 'failed',
            message: `Student cap reached for ${org.organizationName || 'organization'}.`,
            userId: null,
          });
          continue;
        }
      }

      const tempPassword = crypto.randomBytes(6).toString('hex');
      const user = await User.create({
        name,
        email,
        password: tempPassword,
        passwordConfirm: tempPassword,
        role: 'user',
        orgRole: 'student',
        organization: job.organization,
      });

      createdCount += 1;
      results.push({
        rowNumber: row.rowNumber,
        email,
        name,
        status: 'created',
        message: 'Student created.',
        userId: user._id,
      });
    }

    job.totalRows = rows.length;
    job.createdCount = createdCount;
    job.failedCount = failedCount;
    job.rowResults = results;
    job.status = 'completed';
    job.completedAt = new Date();
    job.errorMessage = '';
    job._csvPayload = '';
    await job.save({ validateBeforeSave: false });
  } catch (error) {
    job.status = 'failed';
    job.errorMessage = error?.message || 'CSV processing failed.';
    job.completedAt = new Date();
    job._csvPayload = '';
    await job.save({ validateBeforeSave: false });
  }
};

exports.uploadStudentsCsv = upload.single('file');

exports.listOrganizations = catchAsync(async (req, res) => {
  const page = parsePositiveInt(req.query.page, 1, { min: 1, max: 1000000 });
  const limit = parsePositiveInt(req.query.limit, 20, { min: 1, max: 100 });
  const sortBy = String(req.query.sortBy || 'createdAt').trim();
  const sortDir = normalizeSortDirection(req.query.sortDir);

  const filters = {};
  const search = String(req.query.search || '').trim();
  if (search) {
    const safe = new RegExp(escapeRegex(search), 'i');
    filters.$or = [
      { organizationName: safe },
      { type: safe },
      { city: safe },
      { boardAffiliation: safe },
    ];
  }

  ['type', 'city', 'boardAffiliation', 'status', 'complianceFramework'].forEach((field) => {
    const value = String(req.query[field] || '').trim();
    if (value) filters[field] = value;
  });

  const allItems = await Organization.find(filters)
    .populate('accountOwner', 'name email role')
    .populate('therapistRoster', 'name email role orgRole')
    .lean();

  const orgIds = allItems.map((item) => item._id);
  const [studentCounts, onboardedCounts] = await Promise.all([
    User.aggregate([
      {
        $match: {
          organization: { $in: orgIds },
          role: 'user',
        },
      },
      {
        $group: {
          _id: '$organization',
          count: { $sum: 1 },
        },
      },
    ]),
    User.aggregate([
      {
        $match: {
          organization: { $in: orgIds },
          role: 'user',
          hasOnboarded: true,
        },
      },
      {
        $group: {
          _id: '$organization',
          count: { $sum: 1 },
        },
      },
    ]),
  ]);

  const totalMap = new Map(studentCounts.map((row) => [String(row._id), Number(row.count || 0)]));
  const onboardedMap = new Map(onboardedCounts.map((row) => [String(row._id), Number(row.count || 0)]));

  let items = allItems.map((item) => {
    const totalStudents = Number(totalMap.get(String(item._id)) || 0);
    const onboardedStudents = Number(onboardedMap.get(String(item._id)) || 0);
    const complianceScore = totalStudents
      ? Math.round((onboardedStudents / totalStudents) * 100)
      : 0;

    return {
      ...item,
      studentCount: totalStudents,
      complianceScore,
    };
  });

  if (req.query.complianceScoreMin !== undefined) {
    const min = Number(req.query.complianceScoreMin) || 0;
    items = items.filter((item) => Number(item.complianceScore || 0) >= min);
  }
  if (req.query.complianceScoreMax !== undefined) {
    const max = Number(req.query.complianceScoreMax) || 100;
    items = items.filter((item) => Number(item.complianceScore || 0) <= max);
  }

  items.sort((a, b) => {
    const av = a?.[sortBy];
    const bv = b?.[sortBy];

    if (av === undefined && bv === undefined) return 0;
    if (av === undefined) return 1 * sortDir;
    if (bv === undefined) return -1 * sortDir;

    if (typeof av === 'number' && typeof bv === 'number') {
      return (av - bv) * sortDir;
    }

    return String(av).localeCompare(String(bv)) * sortDir;
  });

  const total = items.length;
  const pagedItems = items.slice((page - 1) * limit, page * limit);

  res.status(200).json({
    status: 'success',
    data: pagedItems,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
  });
});

exports.getOrganizationDetail = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const org = await Organization.findById(id)
    .populate('accountOwner', 'name email role')
    .populate('therapistRoster', 'name email role orgRole')
    .lean();

  if (!org) return next(new AppError('Organization not found.', 404));

  const [studentCount, onboardedStudents, importJobsCount] = await Promise.all([
    getOrgStudentCount(org._id),
    getOrgOnboardedStudentCount(org._id),
    StudentImportJob.countDocuments({ organization: org._id }),
  ]);

  const complianceScore = studentCount
    ? Math.round((onboardedStudents / studentCount) * 100)
    : 0;

  const usersSummary = await User.aggregate([
    { $match: { organization: org._id } },
    { $group: { _id: '$role', count: { $sum: 1 } } },
  ]);
  const byRole = Object.fromEntries(usersSummary.map((row) => [String(row._id || ''), Number(row.count || 0)]));

  res.status(200).json({
    status: 'success',
    data: {
      ...org,
      studentCount,
      complianceScore,
      rosterCount: Array.isArray(org.therapistRoster) ? org.therapistRoster.length : 0,
      stats: {
        usersTotal: Object.values(byRole).reduce((sum, item) => sum + Number(item || 0), 0),
        usersByRole: byRole,
        importJobsCount,
      },
    },
  });
});

exports.listOrganizationUsers = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const org = await Organization.findById(id).select('_id').lean();
  if (!org) return next(new AppError('Organization not found.', 404));

  const page = parsePositiveInt(req.query.page, 1, { min: 1, max: 1000000 });
  const limit = parsePositiveInt(req.query.limit, 20, { min: 1, max: 100 });
  const sortBy = String(req.query.sortBy || 'createdAt');
  const sortDir = normalizeSortDirection(req.query.sortDir);

  const filters = { organization: org._id };
  const search = String(req.query.search || '').trim();
  if (search) {
    const safe = new RegExp(escapeRegex(search), 'i');
    filters.$or = [{ name: safe }, { email: safe }];
  }
  ['role', 'orgRole'].forEach((field) => {
    const value = String(req.query[field] || '').trim();
    if (value) filters[field] = value;
  });

  const total = await User.countDocuments(filters);
  const items = await User.find(filters)
    .select('name email role orgRole suspended hasOnboarded assignedTherapist createdAt')
    .populate('assignedTherapist', 'name email')
    .sort({ [sortBy]: sortDir })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();

  res.status(200).json({
    status: 'success',
    data: items,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
  });
});

exports.listOrganizationImportJobs = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const org = await Organization.findById(id).select('_id').lean();
  if (!org) return next(new AppError('Organization not found.', 404));

  const page = parsePositiveInt(req.query.page, 1, { min: 1, max: 1000000 });
  const limit = parsePositiveInt(req.query.limit, 20, { min: 1, max: 100 });

  const filters = { organization: org._id };
  if (req.query.status) filters.status = String(req.query.status);

  const total = await StudentImportJob.countDocuments(filters);
  const items = await StudentImportJob.find(filters)
    .populate('organization', 'organizationName')
    .populate('createdBy', 'name email')
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();

  res.status(200).json({
    status: 'success',
    data: items,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
  });
});

exports.listOrganizationAuditLogs = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const org = await Organization.findById(id).select('_id').lean();
  if (!org) return next(new AppError('Organization not found.', 404));

  const page = parsePositiveInt(req.query.page, 1, { min: 1, max: 1000000 });
  const limit = parsePositiveInt(req.query.limit, 30, { min: 1, max: 100 });

  const filters = {
    targetType: 'organization',
    targetId: String(org._id),
  };

  const total = await AdminAuditLog.countDocuments(filters);
  const items = await AdminAuditLog.find(filters)
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();

  res.status(200).json({
    status: 'success',
    data: items,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
  });
});

exports.createOrganization = catchAsync(async (req, res, next) => {
  const body = req.body || {};
  if (!body.organizationName) {
    return next(new AppError('organizationName is required.', 400));
  }

  const org = await Organization.create({
    organizationId: generateOrganizationLegacyId(),
    name: body.organizationName,
    organizationName: body.organizationName,
    type: body.type || '',
    boardAffiliation: body.boardAffiliation || '',
    studentCap: Number(body.studentCap || 0),
    city: body.city || '',
    status: body.status || 'onboarding',
    complianceFramework: body.complianceFramework || 'sc_only',
    accountOwner: body.accountOwner || null,
    therapistRoster: Array.isArray(body.therapistRoster) ? body.therapistRoster : [],
  });

  await writeAuditLog({
    req,
    actionType: 'admin.organization.create',
    targetType: 'organization',
    targetId: org._id,
    reason: body.reason || '',
    before: null,
    after: org.toObject(),
  });

  res.status(201).json({ status: 'success', data: org });
});

exports.updateOrganization = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const reason = String(req.body.reason || '').trim();
  const before = await Organization.findById(id);
  if (!before) return next(new AppError('Organization not found.', 404));

  const updates = {};
  [
    'name',
    'organizationName',
    'type',
    'boardAffiliation',
    'studentCap',
    'city',
    'status',
    'complianceFramework',
    'accountOwner',
  ].forEach((key) => {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  });

  // Keep legacy `name` and `organizationName` in sync.
  if (updates.organizationName !== undefined && updates.name === undefined) {
    updates.name = updates.organizationName;
  }
  if (updates.name !== undefined && updates.organizationName === undefined) {
    updates.organizationName = updates.name;
  }

  if (Array.isArray(req.body.therapistRoster)) {
    updates.therapistRoster = req.body.therapistRoster;
  }

  const org = await Organization.findByIdAndUpdate(id, updates, {
    new: true,
    runValidators: true,
  });

  await writeAuditLog({
    req,
    actionType: 'admin.organization.update',
    targetType: 'organization',
    targetId: id,
    reason,
    before: before.toObject(),
    after: org.toObject(),
  });

  res.status(200).json({ status: 'success', data: org });
});

exports.deleteOrganization = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const reason = String(req.body?.reason || req.query?.reason || '').trim();
  const org = await Organization.findById(id);
  if (!org) return next(new AppError('Organization not found.', 404));

  await Organization.findByIdAndDelete(id);

  await writeAuditLog({
    req,
    actionType: 'admin.organization.delete',
    targetType: 'organization',
    targetId: id,
    reason,
    before: org.toObject(),
    after: null,
  });

  res.status(200).json({ status: 'success', data: { id } });
});

exports.generateOrganizationInviteCode = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const reason = String(req.body.reason || '').trim();

  const org = await Organization.findById(id);
  if (!org) return next(new AppError('Organization not found.', 404));

  const before = org.toObject();
  org.joinCode = generateJoinCode();
  org.joinCodeActive = true;
  org.joinCodeCreatedAt = new Date();
  org.joinCodeRevokedAt = null;
  await org.save({ validateBeforeSave: false });

  await writeAuditLog({
    req,
    actionType: 'admin.organization.invite.generate',
    targetType: 'organization',
    targetId: id,
    reason,
    before,
    after: org.toObject(),
  });

  res.status(200).json({
    status: 'success',
    data: {
      joinCode: org.joinCode,
      joinCodeActive: org.joinCodeActive,
      joinCodeCreatedAt: org.joinCodeCreatedAt,
      joinCodeRevokedAt: org.joinCodeRevokedAt,
    },
  });
});

exports.revokeOrganizationInviteCode = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const reason = String(req.body.reason || '').trim();

  const org = await Organization.findById(id);
  if (!org) return next(new AppError('Organization not found.', 404));

  const before = org.toObject();
  org.joinCodeActive = false;
  org.joinCodeRevokedAt = new Date();
  await org.save({ validateBeforeSave: false });

  await writeAuditLog({
    req,
    actionType: 'admin.organization.invite.revoke',
    targetType: 'organization',
    targetId: id,
    reason,
    before,
    after: org.toObject(),
  });

  res.status(200).json({ status: 'success', data: org });
});

exports.addRosterMember = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { userId, reason = '' } = req.body;

  if (!userId) return next(new AppError('userId is required.', 400));

  const [org, user] = await Promise.all([
    Organization.findById(id),
    User.findById(userId).select('role orgRole'),
  ]);

  if (!org) return next(new AppError('Organization not found.', 404));
  if (!user || user.role !== 'therapist') {
    return next(new AppError('Only therapist accounts can be added to roster.', 400));
  }

  const before = org.toObject();
  const exists = org.therapistRoster.some((item) => String(item) === String(userId));
  if (!exists) {
    org.therapistRoster.push(user._id);
    await org.save({ validateBeforeSave: false });
  }

  await writeAuditLog({
    req,
    actionType: 'admin.organization.roster.add',
    targetType: 'organization',
    targetId: id,
    reason,
    before,
    after: org.toObject(),
  });

  res.status(200).json({ status: 'success', data: org });
});

exports.removeRosterMember = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { userId, reason = '' } = req.body;

  if (!userId) return next(new AppError('userId is required.', 400));

  const org = await Organization.findById(id);
  if (!org) return next(new AppError('Organization not found.', 404));

  const before = org.toObject();
  org.therapistRoster = org.therapistRoster.filter((item) => String(item) !== String(userId));
  await org.save({ validateBeforeSave: false });

  await writeAuditLog({
    req,
    actionType: 'admin.organization.roster.remove',
    targetType: 'organization',
    targetId: id,
    reason,
    before,
    after: org.toObject(),
  });

  res.status(200).json({ status: 'success', data: org });
});

exports.listUsers = catchAsync(async (req, res) => {
  const page = parsePositiveInt(req.query.page, 1, { min: 1, max: 1000000 });
  const limit = parsePositiveInt(req.query.limit, 20, { min: 1, max: 100 });
  const sortBy = String(req.query.sortBy || 'createdAt');
  const sortDir = normalizeSortDirection(req.query.sortDir);

  const filters = {};
  const search = String(req.query.search || '').trim();
  if (search) {
    const safe = new RegExp(escapeRegex(search), 'i');
    filters.$or = [{ name: safe }, { email: safe }];
  }

  ['role', 'orgRole'].forEach((field) => {
    const value = String(req.query[field] || '').trim();
    if (value) filters[field] = value;
  });

  if (req.query.organization) {
    const orgId = String(req.query.organization).trim();
    if (mongoose.Types.ObjectId.isValid(orgId)) {
      filters.organization = new mongoose.Types.ObjectId(orgId);
    }
  }

  if (req.query.suspended !== undefined) {
    filters.suspended = String(req.query.suspended).toLowerCase() === 'true';
  }

  const total = await User.countDocuments(filters);
  const items = await User.find(filters)
    .select('name email role orgRole organization assignedTherapist suspended suspensionReason sessionVersion hasOnboarded createdAt')
    .populate('organization', 'organizationName status')
    .populate('assignedTherapist', 'name email')
    .sort({ [sortBy]: sortDir })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();

  res.status(200).json({
    status: 'success',
    data: items,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
  });
});

exports.createUser = catchAsync(async (req, res, next) => {
  const body = req.body || {};
  if (!body.name || !body.email || !body.password || !body.passwordConfirm) {
    return next(new AppError('name, email, password, passwordConfirm are required.', 400));
  }

  if (body.role === 'user' && body.organization) {
    const org = await Organization.findById(body.organization)
      .select('studentCap organizationName')
      .lean();
    if (!org) {
      return next(new AppError('Organization not found for this user.', 404));
    }
    if (Number(org.studentCap || 0) > 0) {
      const currentCount = await getOrgStudentCount(org._id);
      if (currentCount >= Number(org.studentCap || 0)) {
        return next(new AppError(`Student cap reached for ${org.organizationName || 'organization'}.`, 400));
      }
    }
  }

  const user = await User.create({
    name: body.name,
    email: String(body.email).toLowerCase(),
    password: body.password,
    passwordConfirm: body.passwordConfirm,
    role: body.role || 'user',
    orgRole: body.orgRole || '',
    organization: body.organization || null,
    assignedTherapist: body.assignedTherapist || null,
  });

  await writeAuditLog({
    req,
    actionType: 'admin.user.create',
    targetType: 'user',
    targetId: user._id,
    reason: body.reason || '',
    before: null,
    after: sanitizeUserForAudit(user),
  });

  res.status(201).json({
    status: 'success',
    data: sanitizeUserForAudit(user),
  });
});

exports.updateUser = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const reason = String(req.body.reason || '').trim();

  const before = await User.findById(id)
    .select('name email role orgRole organization assignedTherapist suspended suspensionReason sessionVersion')
    .lean();
  if (!before) return next(new AppError('User not found.', 404));

  const updates = {};
  [
    'name',
    'email',
    'role',
    'orgRole',
    'organization',
    'assignedTherapist',
    'suspended',
    'suspensionReason',
  ].forEach((key) => {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  });

  if (updates.email) updates.email = String(updates.email).toLowerCase();

  const user = await User.findByIdAndUpdate(id, updates, {
    new: true,
    runValidators: true,
  }).select('name email role orgRole organization assignedTherapist suspended suspensionReason sessionVersion');

  await writeAuditLog({
    req,
    actionType: 'admin.user.update',
    targetType: 'user',
    targetId: id,
    reason,
    before,
    after: sanitizeUserForAudit(user),
  });

  res.status(200).json({ status: 'success', data: sanitizeUserForAudit(user) });
});

exports.suspendUser = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const reason = String(req.body.reason || '').trim();
  if (!reason) return next(new AppError('reason is required.', 400));

  const user = await User.findById(id);
  if (!user) return next(new AppError('User not found.', 404));

  const before = sanitizeUserForAudit(user);
  user.suspended = true;
  user.suspensionReason = reason;
  user.sessionVersion = Number(user.sessionVersion || 0) + 1;
  await user.save({ validateBeforeSave: false });

  await writeAuditLog({
    req,
    actionType: 'admin.user.suspend',
    targetType: 'user',
    targetId: id,
    reason,
    before,
    after: sanitizeUserForAudit(user),
  });

  res.status(200).json({ status: 'success', data: sanitizeUserForAudit(user) });
});

exports.deleteUser = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const reason = String(req.body?.reason || req.query?.reason || '').trim();

  const user = await User.findById(id);
  if (!user) return next(new AppError('User not found.', 404));

  const before = sanitizeUserForAudit(user);
  await User.findByIdAndDelete(id);

  await writeAuditLog({
    req,
    actionType: 'admin.user.delete',
    targetType: 'user',
    targetId: id,
    reason,
    before,
    after: null,
  });

  res.status(200).json({ status: 'success', data: { id } });
});

exports.reassignSupport = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { therapistUserId, reason = '' } = req.body;
  if (!therapistUserId) return next(new AppError('therapistUserId is required.', 400));

  const [user, therapist] = await Promise.all([
    User.findById(id),
    User.findById(therapistUserId).select('role'),
  ]);

  if (!user || user.role !== 'user') {
    return next(new AppError('Target student user not found.', 404));
  }
  if (!therapist || therapist.role !== 'therapist') {
    return next(new AppError('Assigned support must be a therapist account.', 400));
  }

  const before = sanitizeUserForAudit(user);
  user.assignedTherapist = therapist._id;
  await user.save({ validateBeforeSave: false });

  await writeAuditLog({
    req,
    actionType: 'admin.user.reassign_support',
    targetType: 'user',
    targetId: id,
    reason,
    before,
    after: sanitizeUserForAudit(user),
  });

  res.status(200).json({ status: 'success', data: sanitizeUserForAudit(user) });
});

exports.forceLogout = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const reason = String(req.body.reason || '').trim();

  const user = await User.findById(id);
  if (!user) return next(new AppError('User not found.', 404));

  const before = sanitizeUserForAudit(user);
  user.sessionVersion = Number(user.sessionVersion || 0) + 1;
  await user.save({ validateBeforeSave: false });

  await writeAuditLog({
    req,
    actionType: 'admin.user.force_logout',
    targetType: 'user',
    targetId: id,
    reason,
    before,
    after: sanitizeUserForAudit(user),
  });

  res.status(200).json({ status: 'success', data: { id: user._id, sessionVersion: user.sessionVersion } });
});

exports.resetUserPassword = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { newPassword, reason = '' } = req.body;
  if (!newPassword || String(newPassword).length < 8) {
    return next(new AppError('newPassword must be at least 8 characters.', 400));
  }

  const user = await User.findById(id).select('+password');
  if (!user) return next(new AppError('User not found.', 404));

  const before = sanitizeUserForAudit(user);
  user.password = String(newPassword);
  user.passwordConfirm = String(newPassword);
  user.sessionVersion = Number(user.sessionVersion || 0) + 1;
  await user.save();

  await writeAuditLog({
    req,
    actionType: 'admin.user.reset_password',
    targetType: 'user',
    targetId: id,
    reason,
    before,
    after: sanitizeUserForAudit(user),
  });

  res.status(200).json({ status: 'success', data: { id: user._id } });
});

exports.impersonateUser = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const reason = String(req.body.reason || '').trim();

  const user = await User.findById(id)
    .select('role suspended sessionVersion')
    .lean();
  if (!user) return next(new AppError('User not found.', 404));
  if (user.suspended) return next(new AppError('Cannot impersonate suspended users.', 400));

  const token = signAdminToken({
    id: user._id,
    sessionVersion: Number(user.sessionVersion || 0),
    impersonatedBy: {
      id: req.user._id,
      email: req.user.email,
      name: req.user.name,
      role: req.user.role,
    },
  });

  await writeAuditLog({
    req,
    actionType: 'admin.user.impersonate',
    targetType: 'user',
    targetId: id,
    reason,
    before: null,
    after: { impersonatedUserId: id },
  });

  res.status(200).json({
    status: 'success',
    data: {
      token,
      expiresIn: '15m',
      userId: id,
    },
  });
});

exports.createStudentImportJob = catchAsync(async (req, res, next) => {
  const orgId = String(req.body.organizationId || '').trim();
  if (!orgId || !mongoose.Types.ObjectId.isValid(orgId)) {
    return next(new AppError('Valid organizationId is required.', 400));
  }
  if (!req.file) {
    return next(new AppError('CSV file is required in field "file".', 400));
  }

  const organization = await Organization.findById(orgId).select('_id organizationName');
  if (!organization) return next(new AppError('Organization not found.', 404));

  const job = await StudentImportJob.create({
    organization: organization._id,
    createdBy: req.user._id,
    fileName: req.file.originalname || 'students.csv',
    status: 'queued',
    _csvPayload: req.file.buffer.toString('utf8'),
  });

  await writeAuditLog({
    req,
    actionType: 'admin.import.students.create_job',
    targetType: 'student_import_job',
    targetId: job._id,
    reason: String(req.body.reason || ''),
    before: null,
    after: { organizationId: orgId, fileName: job.fileName },
  });

  setImmediate(() => {
    processStudentImportJob(job._id).catch((error) => {
      console.error('Student import process failed:', error?.message || error);
    });
  });

  res.status(201).json({
    status: 'success',
    data: {
      id: job._id,
      status: job.status,
      organization: organization._id,
      fileName: job.fileName,
      createdAt: job.createdAt,
    },
  });
});

exports.getStudentImportJob = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const job = await StudentImportJob.findById(id)
    .populate('organization', 'organizationName')
    .populate('createdBy', 'name email')
    .lean();

  if (!job) return next(new AppError('Import job not found.', 404));
  delete job._csvPayload;

  res.status(200).json({ status: 'success', data: job });
});

exports.listStudentImportJobs = catchAsync(async (req, res) => {
  const page = parsePositiveInt(req.query.page, 1, { min: 1, max: 1000000 });
  const limit = parsePositiveInt(req.query.limit, 20, { min: 1, max: 100 });

  const filters = {};
  if (req.query.organization && mongoose.Types.ObjectId.isValid(String(req.query.organization))) {
    filters.organization = new mongoose.Types.ObjectId(String(req.query.organization));
  }
  if (req.query.status) {
    filters.status = String(req.query.status);
  }

  const total = await StudentImportJob.countDocuments(filters);
  const items = await StudentImportJob.find(filters)
    .populate('organization', 'organizationName')
    .populate('createdBy', 'name email')
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();

  const data = items.map((item) => {
    const copy = { ...item };
    delete copy._csvPayload;
    return copy;
  });

  res.status(200).json({
    status: 'success',
    data,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
  });
});

exports.listAuditLogs = catchAsync(async (req, res) => {
  const page = parsePositiveInt(req.query.page, 1, { min: 1, max: 1000000 });
  const limit = parsePositiveInt(req.query.limit, 30, { min: 1, max: 100 });
  const filters = {};

  if (req.query.actionType) filters.actionType = String(req.query.actionType).trim();
  if (req.query.targetType) filters.targetType = String(req.query.targetType).trim();
  if (req.query.targetId) filters.targetId = String(req.query.targetId).trim();

  const search = String(req.query.search || '').trim();
  if (search) {
    const safe = new RegExp(escapeRegex(search), 'i');
    filters.$or = [
      { 'actor.email': safe },
      { 'actor.name': safe },
      { reason: safe },
      { actionType: safe },
    ];
  }

  const total = await AdminAuditLog.countDocuments(filters);
  const items = await AdminAuditLog.find(filters)
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();

  res.status(200).json({
    status: 'success',
    data: items,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
  });
});
