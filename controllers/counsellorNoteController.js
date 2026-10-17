const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');
const User = require('../models/userModel');
const CounsellorNote = require('../models/counsellorNoteModel');
const {
  asObjectIdOrNull,
  ensureTeacherStudent,
} = require('../utils/orgScope');
const {
  isStorageReady,
  buildObjectKey,
  presignUpload,
  presignDownload,
  objectExists,
  deleteObject,
  MAX_UPLOAD_BYTES,
  ALLOWED_CONTENT_TYPES,
  UPLOAD_URL_TTL_SECONDS,
} = require('../utils/r2Storage');

const parsePositiveInt = (value, fallback, max = 100) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
};

/* ------------------------------------------------------------------ access */

// Same rule as chat and session reports: a counsellor reaches only their own
// assigned clients.
const ensureOwnClient = async ({ counsellorId, studentId }) => {
  const id = asObjectIdOrNull(studentId);
  if (!id) throw new AppError('Student not found.', 404);

  const student = await User.findById(id)
    .select('name role organization assignedTherapist')
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
  return student;
};

const ensureOwnNote = async ({ counsellorId, noteId }) => {
  const id = asObjectIdOrNull(noteId);
  if (!id) throw new AppError('Note not found.', 404);

  // Scoped by counsellor in the query itself, so another counsellor's note is
  // indistinguishable from one that does not exist.
  const note = await CounsellorNote.findOne({ _id: id, counsellor: counsellorId });
  if (!note) throw new AppError('Note not found.', 404);
  return note;
};

/* ------------------------------------------------------------- projections */

const mapAttachment = (attachment) => ({
  id: attachment._id,
  contentType: attachment.contentType,
  sizeBytes: attachment.sizeBytes,
  originalName: attachment.originalName || '',
  uploadedAt: attachment.uploadedAt,
});

const mapForCounsellor = (note) => ({
  id: note._id,
  student: {
    id: note.student?._id || note.student,
    name: note.student?.name || '',
  },
  body: note.body || '',
  noteAt: note.noteAt,
  visibleToTeacher: Boolean(note.visibleToTeacher),
  attachments: (note.attachments || []).map(mapAttachment),
  createdAt: note.createdAt,
  updatedAt: note.updatedAt,
});

// The teacher's view omits the counsellor's identity-free framing entirely —
// they get the note the counsellor chose to share and nothing more.
const mapForTeacher = (note) => ({
  id: note._id,
  body: note.body || '',
  noteAt: note.noteAt,
  attachments: (note.attachments || []).map(mapAttachment),
  sharedAt: note.updatedAt,
});

/* -------------------------------------------------------------- counsellor */

// POST /api/v1/counsellor-notes
exports.createNote = catchAsync(async (req, res, next) => {
  const student = await ensureOwnClient({
    counsellorId: req.user._id,
    studentId: req.body?.studentId,
  });

  const body = String(req.body?.body || '').trim();
  if (!body) {
    return next(new AppError('A note needs some text.', 400));
  }

  const noteAt = req.body?.noteAt ? new Date(req.body.noteAt) : new Date();
  if (Number.isNaN(noteAt.getTime())) {
    return next(new AppError('noteAt is not a valid date.', 400));
  }

  const note = await CounsellorNote.create({
    counsellor: req.user._id,
    student: student._id,
    organization: student.organization || null,
    body,
    noteAt,
    // Sharing is always a separate, deliberate action. A note cannot be born
    // visible to a teacher.
    visibleToTeacher: false,
  });

  res.status(201).json({ status: 'success', data: mapForCounsellor(note) });
});

// GET /api/v1/counsellor-notes/student/:id
exports.listNotesForStudent = catchAsync(async (req, res) => {
  const student = await ensureOwnClient({
    counsellorId: req.user._id,
    studentId: req.params.id,
  });

  const page = parsePositiveInt(req.query.page, 1, 1000);
  const limit = parsePositiveInt(req.query.limit, 50, 100);

  const filter = { counsellor: req.user._id, student: student._id };

  const [items, total] = await Promise.all([
    CounsellorNote.find(filter)
      .sort({ noteAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    CounsellorNote.countDocuments(filter),
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

// PATCH /api/v1/counsellor-notes/:id
exports.updateNote = catchAsync(async (req, res, next) => {
  const note = await ensureOwnNote({
    counsellorId: req.user._id,
    noteId: req.params.id,
  });

  if (req.body?.body !== undefined) {
    const body = String(req.body.body || '').trim();
    if (!body && !(note.attachments || []).length) {
      return next(new AppError('A note needs either text or an attachment.', 400));
    }
    note.body = body;
  }

  if (req.body?.noteAt !== undefined) {
    const noteAt = new Date(req.body.noteAt);
    if (Number.isNaN(noteAt.getTime())) {
      return next(new AppError('noteAt is not a valid date.', 400));
    }
    note.noteAt = noteAt;
  }

  await note.save();
  res.status(200).json({ status: 'success', data: mapForCounsellor(note) });
});

// PATCH /api/v1/counsellor-notes/:id/visibility
exports.setNoteVisibility = catchAsync(async (req, res, next) => {
  const note = await ensureOwnNote({
    counsellorId: req.user._id,
    noteId: req.params.id,
  });

  if (typeof req.body?.visibleToTeacher !== 'boolean') {
    return next(new AppError('visibleToTeacher must be true or false.', 400));
  }

  note.visibleToTeacher = req.body.visibleToTeacher;
  await note.save();

  res.status(200).json({ status: 'success', data: mapForCounsellor(note) });
});

// DELETE /api/v1/counsellor-notes/:id
exports.deleteNote = catchAsync(async (req, res) => {
  const note = await ensureOwnNote({
    counsellorId: req.user._id,
    noteId: req.params.id,
  });

  // Delete the objects before the row. The other order orphans files in R2 with
  // nothing left pointing at them to clean up — the exact shape of finding the
  // DPDP audit already raised about cascade deletes.
  if (isStorageReady()) {
    for (const attachment of note.attachments || []) {
      try {
        await deleteObject({ key: attachment.r2Key });
      } catch {
        // A missing object should not block deleting the note; the note row is
        // the thing that makes the data reachable.
      }
    }
  }

  await CounsellorNote.deleteOne({ _id: note._id });

  res.status(200).json({ status: 'success', data: { id: note._id } });
});

/* ------------------------------------------------------------- attachments */

// POST /api/v1/counsellor-notes/:id/attachments/presign
exports.presignAttachmentUpload = catchAsync(async (req, res, next) => {
  if (!isStorageReady()) {
    return next(
      new AppError(
        'Photo storage is not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET.',
        503,
      ),
    );
  }

  const note = await ensureOwnNote({
    counsellorId: req.user._id,
    noteId: req.params.id,
  });

  const contentType = String(req.body?.contentType || '').trim().toLowerCase();
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    return next(
      new AppError(
        `contentType must be one of: ${[...ALLOWED_CONTENT_TYPES].join(', ')}.`,
        400,
      ),
    );
  }

  const contentLength = Number(req.body?.contentLength);
  if (!Number.isFinite(contentLength) || contentLength <= 0) {
    return next(new AppError('contentLength is required.', 400));
  }
  if (contentLength > MAX_UPLOAD_BYTES) {
    return next(
      new AppError(
        `That file is too large. The limit is ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB.`,
        400,
      ),
    );
  }

  const key = buildObjectKey({
    organizationId: note.organization || 'no-org',
    studentId: note.student,
    noteId: note._id,
    contentType,
  });

  const uploadUrl = await presignUpload({ key, contentType, contentLength });

  res.status(200).json({
    status: 'success',
    data: { key, uploadUrl, expiresInSeconds: UPLOAD_URL_TTL_SECONDS },
  });
});

// POST /api/v1/counsellor-notes/:id/attachments
//
// Called after the browser has PUT the file to the presigned URL. The key is
// re-derived against this note rather than trusted, so a counsellor cannot
// attach an object belonging to a different note or student.
exports.confirmAttachment = catchAsync(async (req, res, next) => {
  if (!isStorageReady()) {
    return next(new AppError('Photo storage is not configured.', 503));
  }

  const note = await ensureOwnNote({
    counsellorId: req.user._id,
    noteId: req.params.id,
  });

  const key = String(req.body?.key || '').trim();
  const expectedPrefix = `notes/${note.organization || 'no-org'}/${note.student}/${note._id}/`;
  if (!key.startsWith(expectedPrefix)) {
    return next(new AppError('That upload does not belong to this note.', 400));
  }

  if (!(await objectExists({ key }))) {
    return next(
      new AppError('That upload did not complete. Try uploading again.', 400),
    );
  }

  const contentType = String(req.body?.contentType || '').trim().toLowerCase();
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    return next(new AppError('Unsupported contentType.', 400));
  }

  note.attachments.push({
    r2Key: key,
    contentType,
    sizeBytes: Number(req.body?.sizeBytes) || 0,
    originalName: String(req.body?.originalName || '').trim().slice(0, 260),
    uploadedAt: new Date(),
  });
  await note.save();

  res.status(201).json({ status: 'success', data: mapForCounsellor(note) });
});

// GET /api/v1/counsellor-notes/:id/attachments/:attachmentId/url
//
// A fresh short-lived URL per request, issued only after the same access check
// as the note. Shared by the counsellor who owns the note and, for a shared
// note, the student's teacher.
exports.getAttachmentUrl = catchAsync(async (req, res, next) => {
  if (!isStorageReady()) {
    return next(new AppError('Photo storage is not configured.', 503));
  }

  const noteId = asObjectIdOrNull(req.params.id);
  if (!noteId) return next(new AppError('Note not found.', 404));

  const isTeacher =
    req.user.role === 'teacher' || (req.user.roles || []).includes('teacher');

  let note;
  if (isTeacher) {
    note = await CounsellorNote.findOne({
      _id: noteId,
      visibleToTeacher: true,
    }).lean();
    if (!note) return next(new AppError('Note not found.', 404));
    // Proves the student is in one of this teacher's own classrooms.
    await ensureTeacherStudent({
      teacherId: req.user._id,
      studentId: String(note.student),
    });
  } else {
    note = await CounsellorNote.findOne({
      _id: noteId,
      counsellor: req.user._id,
    }).lean();
    if (!note) return next(new AppError('Note not found.', 404));
  }

  const attachment = (note.attachments || []).find(
    (item) => String(item._id) === String(req.params.attachmentId),
  );
  if (!attachment) return next(new AppError('Attachment not found.', 404));

  const url = await presignDownload({ key: attachment.r2Key });

  res.status(200).json({ status: 'success', data: { url } });
});

// DELETE /api/v1/counsellor-notes/:id/attachments/:attachmentId
exports.deleteAttachment = catchAsync(async (req, res, next) => {
  const note = await ensureOwnNote({
    counsellorId: req.user._id,
    noteId: req.params.id,
  });

  const attachment = (note.attachments || []).find(
    (item) => String(item._id) === String(req.params.attachmentId),
  );
  if (!attachment) return next(new AppError('Attachment not found.', 404));

  if (!String(note.body || '').trim() && note.attachments.length === 1) {
    return next(
      new AppError(
        'That is the only content on this note. Delete the note instead.',
        400,
      ),
    );
  }

  if (isStorageReady()) {
    try {
      await deleteObject({ key: attachment.r2Key });
    } catch {
      // Same reasoning as deleteNote: a missing object must not wedge the row.
    }
  }

  note.attachments.pull({ _id: attachment._id });
  await note.save();

  res.status(200).json({ status: 'success', data: mapForCounsellor(note) });
});

/* ----------------------------------------------------------------- teacher */

// GET /api/v1/counsellor-notes/shared/student/:id
exports.listSharedNotesForStudent = catchAsync(async (req, res) => {
  // 404s unless the student is in one of this teacher's own classrooms.
  const student = await ensureTeacherStudent({
    teacherId: req.user._id,
    studentId: req.params.id,
  });

  const notes = await CounsellorNote.find({
    student: student._id,
    visibleToTeacher: true,
  })
    .sort({ noteAt: -1 })
    .limit(100)
    .lean();

  res.status(200).json({
    status: 'success',
    results: notes.length,
    data: notes.map(mapForTeacher),
  });
});
