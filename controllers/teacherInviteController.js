const multer = require('multer');
const validator = require('validator');
const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');
const User = require('../models/userModel');
const Classroom = require('../models/classroomModel');
const TeacherInvite = require('../models/teacherInviteModel');
const Organization = require('../models/organizationModel');
const { asObjectIdOrNull } = require('../utils/orgScope');

const MAX_ENTRIES = 500;

// Same memoryStorage shape ticketController already uses.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok =
      file.mimetype === 'text/csv' ||
      file.mimetype === 'application/vnd.ms-excel' ||
      file.mimetype === 'text/plain' ||
      /\.csv$/i.test(file.originalname || '');
    if (!ok) return cb(new AppError('Upload a .csv file.', 400));
    cb(null, true);
  },
});

exports.uploadInviteCsv = upload.single('file');

// ~20 lines by hand rather than a csv dependency, matching the repo's
// no-new-dependencies posture. Header row optional; columns: email,name
const parseCsv = (buffer) => {
  const text = String(buffer || '').toString();
  const rows = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const entries = [];
  rows.forEach((line, index) => {
    const cells = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
    const email = String(cells[0] || '').toLowerCase();
    if (index === 0 && (email === 'email' || !email.includes('@'))) return;
    if (!email) return;
    entries.push({ email, name: cells[1] || '', row: index + 1 });
  });
  return entries;
};

const normalizeEntries = (body) => {
  if (Array.isArray(body?.entries)) {
    return body.entries.map((e, i) => ({
      email: String(e?.email || '').trim().toLowerCase(),
      name: String(e?.name || '').trim(),
      classroomIds: Array.isArray(e?.classroomIds)
        ? e.classroomIds.map(asObjectIdOrNull).filter(Boolean)
        : [],
      row: i + 1,
    }));
  }
  if (Array.isArray(body?.emails)) {
    return body.emails.map((e, i) => ({
      email: String(e || '').trim().toLowerCase(),
      name: '',
      classroomIds: [],
      row: i + 1,
    }));
  }
  return [];
};

// Shared by the JSON and CSV intake paths. Idempotent upserts keyed on
// { organization, email }, so re-uploading the same roster is a no-op.
const ingestInvites = async ({ organizationId, entries, actor }) => {
  const result = {
    created: 0,
    alreadyPending: 0,
    alreadyClaimed: 0,
    promotedExistingUsers: 0,
    invalid: [],
  };

  const defaultClassrooms = Array.isArray(entries.classroomIds)
    ? entries.classroomIds
    : [];

  for (const entry of entries) {
    const { email, name, row } = entry;

    if (!email || !validator.isEmail(email)) {
      result.invalid.push({ row, email, reason: 'invalid_email' });
      continue;
    }

    const classrooms = entry.classroomIds?.length
      ? entry.classroomIds
      : defaultClassrooms;

    const existingInvite = await TeacherInvite.findOne({ email });
    if (existingInvite?.status === 'pending') {
      result.alreadyPending += 1;
      continue;
    }
    if (existingInvite?.status === 'claimed') {
      result.alreadyClaimed += 1;
      continue;
    }

    // User.email is unique, so an address that already has an account can never
    // sign up again. Resolve it here by promoting in place — otherwise every
    // teacher who ever tried the student app is permanently unprovisionable.
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      if (
        existingUser.role === 'admin' ||
        (existingUser.roles || []).includes('admin')
      ) {
        result.invalid.push({ row, email, reason: 'role_conflict_admin' });
        continue;
      }
      if (
        existingUser.role === 'therapist' ||
        (existingUser.roles || []).includes('therapist')
      ) {
        result.invalid.push({ row, email, reason: 'role_conflict_therapist' });
        continue;
      }

      existingUser.role = 'teacher';
      existingUser.organization = organizationId;
      existingUser.classroom = null; // a teacher is never a classroom member
      await existingUser.save({ validateBeforeSave: false }); // .save() so roles[] syncs

      await TeacherInvite.findOneAndUpdate(
        { email },
        {
          $set: {
            organization: organizationId,
            email,
            name,
            status: 'claimed',
            defaultClassrooms: classrooms,
            invitedBy: actor._id,
            invitedAt: new Date(),
            claimedBy: existingUser._id,
            claimedAt: new Date(),
            source: 'admin_auto_promote',
          },
        },
        { upsert: true },
      );

      if (classrooms.length) {
        await Classroom.updateMany(
          { _id: { $in: classrooms } },
          { $addToSet: { teachers: existingUser._id } },
        );
      }

      result.promotedExistingUsers += 1;
      continue;
    }

    try {
      await TeacherInvite.findOneAndUpdate(
        { email },
        {
          $set: {
            organization: organizationId,
            email,
            name,
            status: 'pending',
            defaultClassrooms: classrooms,
            invitedBy: actor._id,
            invitedAt: new Date(),
            claimedBy: null,
            claimedAt: null,
            revokedAt: null,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
      result.created += 1;
    } catch (err) {
      if (err?.code === 11000) {
        result.alreadyPending += 1;
        continue;
      }
      throw err;
    }
  }

  return result;
};

// POST /api/v1/teacher-invites
exports.createTeacherInvites = catchAsync(async (req, res, next) => {
  const organizationId = asObjectIdOrNull(req.body?.organizationId);
  if (!organizationId) {
    return next(new AppError('A valid organizationId is required.', 400));
  }

  const organization = await Organization.findById(organizationId)
    .select('_id')
    .lean();
  if (!organization) return next(new AppError('Organization not found.', 404));

  const entries = normalizeEntries(req.body);
  if (!entries.length) {
    return next(
      new AppError('Provide `emails` or `entries` with at least one row.', 400),
    );
  }
  if (entries.length > MAX_ENTRIES) {
    return next(
      new AppError(`Upload at most ${MAX_ENTRIES} teachers at a time.`, 400),
    );
  }

  const result = await ingestInvites({
    organizationId,
    entries,
    actor: req.user,
  });

  res.status(201).json({ status: 'success', data: result });
});

// POST /api/v1/teacher-invites/csv
exports.createTeacherInvitesFromCsv = catchAsync(async (req, res, next) => {
  const organizationId = asObjectIdOrNull(
    req.body?.organizationId || req.query?.organizationId,
  );
  if (!organizationId) {
    return next(new AppError('A valid organizationId is required.', 400));
  }
  if (!req.file?.buffer) {
    return next(new AppError('Attach a .csv file in the `file` field.', 400));
  }

  const entries = parseCsv(req.file.buffer);
  if (!entries.length) {
    return next(new AppError('No usable rows found in that CSV.', 400));
  }
  if (entries.length > MAX_ENTRIES) {
    return next(
      new AppError(`Upload at most ${MAX_ENTRIES} teachers at a time.`, 400),
    );
  }

  const result = await ingestInvites({
    organizationId,
    entries,
    actor: req.user,
  });

  res.status(201).json({ status: 'success', data: result });
});

// GET /api/v1/teacher-invites
exports.listTeacherInvites = catchAsync(async (req, res, next) => {
  const filter = {};
  const organization = asObjectIdOrNull(req.query.organizationId);
  if (organization) filter.organization = organization;
  if (['pending', 'claimed', 'revoked'].includes(req.query.status)) {
    filter.status = req.query.status;
  }

  const invites = await TeacherInvite.find(filter)
    .populate('claimedBy', 'name email')
    .sort({ invitedAt: -1 })
    .lean();

  res
    .status(200)
    .json({ status: 'success', results: invites.length, data: invites });
});

// PATCH /api/v1/teacher-invites/:id
exports.updateTeacherInvite = catchAsync(async (req, res, next) => {
  const invite = await TeacherInvite.findById(req.params.id);
  if (!invite) return next(new AppError('Invite not found.', 404));

  const status = String(req.body?.status || '').trim();
  if (status === 'revoked') {
    if (invite.status === 'claimed') {
      return next(
        new AppError(
          'This invite was already claimed. Demote the user instead: PATCH /users/:id/roles { setRole: "user" }.',
          409,
        ),
      );
    }
    invite.status = 'revoked';
    invite.revokedAt = new Date();
  }

  if (req.body?.name !== undefined) {
    invite.name = String(req.body.name || '').trim();
  }
  if (Array.isArray(req.body?.defaultClassrooms)) {
    invite.defaultClassrooms = req.body.defaultClassrooms
      .map(asObjectIdOrNull)
      .filter(Boolean);
  }

  await invite.save();
  res.status(200).json({ status: 'success', data: invite });
});

// DELETE /api/v1/teacher-invites/:id
exports.deleteTeacherInvite = catchAsync(async (req, res, next) => {
  const invite = await TeacherInvite.findById(req.params.id);
  if (!invite) return next(new AppError('Invite not found.', 404));
  if (invite.status === 'claimed') {
    return next(
      new AppError(
        'This invite was already claimed and is now an audit record.',
        409,
      ),
    );
  }
  await TeacherInvite.deleteOne({ _id: invite._id });
  res.status(200).json({ status: 'success', data: null });
});
