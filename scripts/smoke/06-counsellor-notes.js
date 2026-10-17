// §4 — timestamped counsellor notes, shared with a teacher one note at a time,
// with photo attachments in Cloudflare R2.
//
// The presigned-URL machinery is exercised offline: AWS SigV4 signing is a local
// computation, so a fake set of R2 credentials proves key derivation, scoping and
// validation without a bucket. The one thing not covered here is the actual
// network round-trip to R2 — see MANUAL CHECKS.

const jwt = require('jsonwebtoken');
const { api, check, checkEqual, suite } = require('./harness');

const User = require('../../models/userModel');
const Organization = require('../../models/organizationModel');
const Classroom = require('../../models/classroomModel');
const CounsellorNote = require('../../models/counsellorNoteModel');

const tokenFor = (user) =>
  jwt.sign(
    { id: String(user._id), sessionVersion: Number(user.sessionVersion || 0) },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN },
  );

const mkUser = (over = {}) =>
  User.create({
    name: 'U',
    password: 'test-password-1',
    passwordConfirm: 'test-password-1',
    ...over,
  });

module.exports = async () => {
  suite('§4  counsellor notes + R2 attachments');

  /* ---------------------------------------------------------------- setup */

  const counsellor = await mkUser({
    name: 'Note Counsellor',
    email: 'note.counsellor@smoke.test',
    role: 'therapist',
  });
  const otherCounsellor = await mkUser({
    name: 'Other Note Counsellor',
    email: 'note.other@smoke.test',
    role: 'therapist',
  });

  const org = await Organization.create({
    organizationName: 'Notes School',
    status: 'active',
    joinCode: 'SMOKE6',
    therapistRoster: [counsellor._id, otherCounsellor._id],
  });

  const teacher = await mkUser({
    name: 'Note Teacher',
    email: 'note.teacher@smoke.test',
    role: 'teacher',
    organization: org._id,
  });
  const otherTeacher = await mkUser({
    name: 'Unrelated Teacher',
    email: 'note.otherteacher@smoke.test',
    role: 'teacher',
    organization: org._id,
  });

  const classroom = await Classroom.create({
    organization: org._id,
    name: 'Grade 11',
    grade: '11',
    section: 'A',
    academicYear: '2026-27',
    teachers: [teacher._id],
    homeTeacher: teacher._id,
    assignedCounsellor: counsellor._id,
  });
  await Classroom.create({
    organization: org._id,
    name: 'Grade 12',
    grade: '12',
    section: 'A',
    academicYear: '2026-27',
    teachers: [otherTeacher._id],
    homeTeacher: otherTeacher._id,
  });

  const student = await mkUser({
    name: 'Note Student',
    email: 'note.student@smoke.test',
    role: 'user',
    organization: org._id,
    classroom: classroom._id,
    assignedTherapist: counsellor._id,
  });
  const otherStudent = await mkUser({
    name: 'Other Note Student',
    email: 'note.otherstudent@smoke.test',
    role: 'user',
    organization: org._id,
    classroom: classroom._id,
    assignedTherapist: otherCounsellor._id,
  });

  const counsellorToken = tokenFor(counsellor);
  const otherCounsellorToken = tokenFor(otherCounsellor);
  const teacherToken = tokenFor(teacher);
  const otherTeacherToken = tokenFor(otherTeacher);
  const studentToken = tokenFor(student);

  /* ------------------------------------------------------------- authoring */

  const asStudent = await api('POST', '/counsellor-notes', {
    token: studentToken,
    body: { studentId: String(student._id), body: 'note' },
  });
  checkEqual('a student cannot write counsellor notes', asStudent.status, 403);

  const notMine = await api('POST', '/counsellor-notes', {
    token: counsellorToken,
    body: { studentId: String(otherStudent._id), body: 'Should be refused.' },
  });
  checkEqual(
    'a counsellor cannot write notes on another’s client',
    notMine.status,
    403,
  );

  const empty = await api('POST', '/counsellor-notes', {
    token: counsellorToken,
    body: { studentId: String(student._id), body: '   ' },
  });
  checkEqual('an empty note is refused', empty.status, 400);

  const backdated = new Date('2026-10-14T10:30:00.000Z');
  const created = await api('POST', '/counsellor-notes', {
    token: counsellorToken,
    body: {
      studentId: String(student._id),
      body: 'Checked in after class. Sleeping better this week.',
      noteAt: backdated.toISOString(),
    },
  });
  checkEqual('counsellor writes a note', created.status, 201);
  checkEqual(
    'noteAt is the clinically meaningful timestamp, not now',
    new Date(created.body?.data?.noteAt).toISOString(),
    backdated.toISOString(),
  );
  checkEqual(
    'a new note is private to the counsellor by default',
    created.body?.data?.visibleToTeacher,
    false,
  );

  const noteId = created.body?.data?.id;

  /* ---------------------------------------------------- reading and editing */

  const listed = await api('GET', `/counsellor-notes/student/${student._id}`, {
    token: counsellorToken,
  });
  checkEqual('counsellor lists their notes', listed.body?.data?.length, 1);

  const peeking = await api('GET', `/counsellor-notes/student/${student._id}`, {
    token: otherCounsellorToken,
  });
  checkEqual(
    'another counsellor cannot list notes on a client not theirs',
    peeking.status,
    403,
  );

  const edited = await api('PATCH', `/counsellor-notes/${noteId}`, {
    token: counsellorToken,
    body: { body: 'Checked in after class. Sleeping better; appetite still low.' },
  });
  checkEqual('a note can be amended', edited.status, 200);
  check(
    'amending bumps updatedAt but keeps noteAt',
    new Date(edited.body?.data?.noteAt).toISOString() === backdated.toISOString(),
  );

  const editOther = await api('PATCH', `/counsellor-notes/${noteId}`, {
    token: otherCounsellorToken,
    body: { body: 'tampering' },
  });
  checkEqual('another counsellor cannot edit the note', editOther.status, 404);

  /* ---------------------------------------------------- the sharing decision */

  const beforeShare = await api(
    'GET',
    `/counsellor-notes/shared/student/${student._id}`,
    { token: teacherToken },
  );
  checkEqual('teacher sees no notes by default', beforeShare.body?.data?.length, 0);

  const badVisibility = await api(
    'PATCH',
    `/counsellor-notes/${noteId}/visibility`,
    { token: counsellorToken, body: { visibleToTeacher: 'yes' } },
  );
  checkEqual('visibility must be a boolean', badVisibility.status, 400);

  const shared = await api('PATCH', `/counsellor-notes/${noteId}/visibility`, {
    token: counsellorToken,
    body: { visibleToTeacher: true },
  });
  checkEqual('counsellor shares one note', shared.status, 200);

  const afterShare = await api(
    'GET',
    `/counsellor-notes/shared/student/${student._id}`,
    { token: teacherToken },
  );
  checkEqual('teacher now sees the shared note', afterShare.body?.data?.length, 1);
  check(
    'the teacher view withholds the visibility flag and counsellor id',
    !('visibleToTeacher' in (afterShare.body?.data?.[0] || {})) &&
      !('counsellor' in (afterShare.body?.data?.[0] || {})),
    `keys: ${Object.keys(afterShare.body?.data?.[0] || {}).join(', ')}`,
  );

  const second = await api('POST', '/counsellor-notes', {
    token: counsellorToken,
    body: { studentId: String(student._id), body: 'Disclosed conflict at home.' },
  });
  const secondId = second.body?.data?.id;

  const stillOne = await api(
    'GET',
    `/counsellor-notes/shared/student/${student._id}`,
    { token: teacherToken },
  );
  checkEqual(
    'sharing is per note — a later note stays private',
    stillOne.body?.data?.length,
    1,
  );

  const wrongTeacher = await api(
    'GET',
    `/counsellor-notes/shared/student/${student._id}`,
    { token: otherTeacherToken },
  );
  checkEqual(
    'a teacher from another classroom sees nothing',
    wrongTeacher.status,
    404,
  );

  const unshared = await api('PATCH', `/counsellor-notes/${noteId}/visibility`, {
    token: counsellorToken,
    body: { visibleToTeacher: false },
  });
  checkEqual('a note can be un-shared', unshared.status, 200);
  const afterUnshare = await api(
    'GET',
    `/counsellor-notes/shared/student/${student._id}`,
    { token: teacherToken },
  );
  checkEqual('un-sharing takes effect', afterUnshare.body?.data?.length, 0);

  /* ------------------------------------ attachments with R2 not configured */

  const previousEnv = {
    R2_ACCOUNT_ID: process.env.R2_ACCOUNT_ID,
    R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
    R2_BUCKET: process.env.R2_BUCKET,
  };
  Object.keys(previousEnv).forEach((k) => delete process.env[k]);

  const unconfigured = await api(
    'POST',
    `/counsellor-notes/${noteId}/attachments/presign`,
    {
      token: counsellorToken,
      body: { contentType: 'image/jpeg', contentLength: 1024 },
    },
  );
  checkEqual(
    'attachments degrade to 503 when R2 is unconfigured',
    unconfigured.status,
    503,
  );

  const notesStillWork = await api('POST', '/counsellor-notes', {
    token: counsellorToken,
    body: { studentId: String(student._id), body: 'Notes work without R2.' },
  });
  checkEqual(
    'notes themselves still work without R2',
    notesStillWork.status,
    201,
  );

  /* ---------------------------------- attachments with R2 credentials set */

  process.env.R2_ACCOUNT_ID = 'smoke-account';
  process.env.R2_ACCESS_KEY_ID = 'smoke-access-key';
  process.env.R2_SECRET_ACCESS_KEY = 'smoke-secret-key';
  process.env.R2_BUCKET = 'smoke-bucket';

  const badType = await api(
    'POST',
    `/counsellor-notes/${noteId}/attachments/presign`,
    {
      token: counsellorToken,
      body: { contentType: 'application/x-msdownload', contentLength: 1024 },
    },
  );
  checkEqual('an executable content type is refused', badType.status, 400);

  const tooBig = await api(
    'POST',
    `/counsellor-notes/${noteId}/attachments/presign`,
    {
      token: counsellorToken,
      body: { contentType: 'image/jpeg', contentLength: 50 * 1024 * 1024 },
    },
  );
  checkEqual('an oversized upload is refused', tooBig.status, 400);

  const presigned = await api(
    'POST',
    `/counsellor-notes/${noteId}/attachments/presign`,
    {
      token: counsellorToken,
      body: { contentType: 'image/jpeg', contentLength: 2048 },
    },
  );
  checkEqual('presign succeeds for a valid photo', presigned.status, 200);

  const key = presigned.body?.data?.key || '';
  check(
    'the object key is scoped to org / student / note',
    key.startsWith(`notes/${org._id}/${student._id}/${noteId}/`),
    `got ${key}`,
  );
  check(
    'the upload URL is signed and time-limited',
    String(presigned.body?.data?.uploadUrl || '').includes('X-Amz-Signature') &&
      String(presigned.body?.data?.uploadUrl || '').includes('X-Amz-Expires'),
    `got ${String(presigned.body?.data?.uploadUrl || '').slice(0, 120)}`,
  );
  check(
    'the upload URL targets the R2 endpoint',
    String(presigned.body?.data?.uploadUrl || '').includes(
      'smoke-account.r2.cloudflarestorage.com',
    ),
  );

  const foreignKey = await api(
    'POST',
    `/counsellor-notes/${noteId}/attachments`,
    {
      token: counsellorToken,
      body: {
        key: `notes/${org._id}/${otherStudent._id}/${secondId}/abc.jpg`,
        contentType: 'image/jpeg',
      },
    },
  );
  checkEqual(
    'an object key belonging to another note is refused',
    foreignKey.status,
    400,
  );

  const presignOther = await api(
    'POST',
    `/counsellor-notes/${noteId}/attachments/presign`,
    {
      token: otherCounsellorToken,
      body: { contentType: 'image/jpeg', contentLength: 2048 },
    },
  );
  checkEqual(
    'another counsellor cannot presign against this note',
    presignOther.status,
    404,
  );

  /* ------------------------- attachment reads follow the sharing decision */

  // Written directly: confirming an upload requires a real object in R2.
  await CounsellorNote.updateOne(
    { _id: noteId },
    {
      $push: {
        attachments: {
          r2Key: key,
          contentType: 'image/jpeg',
          sizeBytes: 2048,
          originalName: 'page1.jpg',
          uploadedAt: new Date(),
        },
      },
    },
  );
  const withAttachment = await CounsellorNote.findById(noteId).lean();
  const attachmentId = withAttachment.attachments[0]._id;

  const ownerUrl = await api(
    'GET',
    `/counsellor-notes/${noteId}/attachments/${attachmentId}/url`,
    { token: counsellorToken },
  );
  checkEqual('the owning counsellor gets a download URL', ownerUrl.status, 200);
  check(
    'the download URL is signed and time-limited',
    String(ownerUrl.body?.data?.url || '').includes('X-Amz-Signature'),
  );

  const teacherBlocked = await api(
    'GET',
    `/counsellor-notes/${noteId}/attachments/${attachmentId}/url`,
    { token: teacherToken },
  );
  checkEqual(
    'a teacher cannot fetch an attachment on an unshared note',
    teacherBlocked.status,
    404,
  );

  await api('PATCH', `/counsellor-notes/${noteId}/visibility`, {
    token: counsellorToken,
    body: { visibleToTeacher: true },
  });

  const teacherAllowed = await api(
    'GET',
    `/counsellor-notes/${noteId}/attachments/${attachmentId}/url`,
    { token: teacherToken },
  );
  checkEqual(
    'a teacher can fetch an attachment once the note is shared',
    teacherAllowed.status,
    200,
  );

  const wrongTeacherAttachment = await api(
    'GET',
    `/counsellor-notes/${noteId}/attachments/${attachmentId}/url`,
    { token: otherTeacherToken },
  );
  checkEqual(
    'a teacher from another classroom still cannot fetch it',
    wrongTeacherAttachment.status,
    404,
  );

  const studentBlocked = await api(
    'GET',
    `/counsellor-notes/${noteId}/attachments/${attachmentId}/url`,
    { token: studentToken },
  );
  checkEqual('a student cannot fetch note attachments', studentBlocked.status, 403);

  /* ---------------------------------------------------------------- delete */

  const deleted = await api('DELETE', `/counsellor-notes/${secondId}`, {
    token: counsellorToken,
  });
  checkEqual('counsellor deletes their note', deleted.status, 200);
  const gone = await CounsellorNote.findById(secondId);
  check('the note row is gone', !gone);

  const deleteOther = await api('DELETE', `/counsellor-notes/${noteId}`, {
    token: otherCounsellorToken,
  });
  checkEqual('another counsellor cannot delete the note', deleteOther.status, 404);

  Object.entries(previousEnv).forEach(([k, v]) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  });
};
