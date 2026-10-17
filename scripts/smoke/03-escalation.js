// §2 — counsellors escalate their own clients to their school's admin.

const jwt = require('jsonwebtoken');
const { api, check, checkEqual, suite } = require('./harness');

const User = require('../../models/userModel');
const Organization = require('../../models/organizationModel');
const Classroom = require('../../models/classroomModel');
const Escalation = require('../../models/escalationModel');

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

const LONG_REASON =
  'Repeated disclosures about conflict at home over three sessions; I believe the parents need to be involved.';

module.exports = async () => {
  suite('§2  escalation to school admin');

  /* ---------------------------------------------------------------- setup */

  const counsellor = await mkUser({
    name: 'Esc Counsellor',
    email: 'esc.counsellor@smoke.test',
    role: 'therapist',
  });
  const otherCounsellor = await mkUser({
    name: 'Other Counsellor',
    email: 'esc.other@smoke.test',
    role: 'therapist',
  });

  const org = await Organization.create({
    organizationName: 'Escalation School',
    status: 'active',
    joinCode: 'SMOKE3',
    therapistRoster: [counsellor._id, otherCounsellor._id],
  });
  const foreignOrg = await Organization.create({
    organizationName: 'Foreign Escalation School',
    status: 'active',
    joinCode: 'SMOKE4',
  });

  const classroom = await Classroom.create({
    organization: org._id,
    name: 'Grade 8',
    grade: '8',
    section: 'C',
    academicYear: '2026-27',
    assignedCounsellor: counsellor._id,
  });

  const student = await mkUser({
    name: 'Esc Student',
    email: 'esc.student@smoke.test',
    role: 'user',
    organization: org._id,
    classroom: classroom._id,
    assignedTherapist: counsellor._id,
  });

  const otherStudent = await mkUser({
    name: 'Not My Client',
    email: 'esc.notmine@smoke.test',
    role: 'user',
    organization: org._id,
    classroom: classroom._id,
    assignedTherapist: otherCounsellor._id,
  });

  const schoolAdmin = await mkUser({
    name: 'Esc School Admin',
    email: 'esc.admin@smoke.test',
    role: 'school_admin',
    organization: org._id,
  });
  const foreignAdmin = await mkUser({
    name: 'Foreign Admin',
    email: 'esc.foreignadmin@smoke.test',
    role: 'school_admin',
    organization: foreignOrg._id,
  });
  const teacher = await mkUser({
    name: 'Esc Teacher',
    email: 'esc.teacher@smoke.test',
    role: 'teacher',
    organization: org._id,
  });

  const counsellorToken = tokenFor(counsellor);
  const otherCounsellorToken = tokenFor(otherCounsellor);
  const adminToken = tokenFor(schoolAdmin);
  const foreignAdminToken = tokenFor(foreignAdmin);
  const teacherToken = tokenFor(teacher);
  const studentToken = tokenFor(student);

  /* --------------------------------------------------------- authorisation */

  const asStudent = await api('POST', '/escalations', {
    token: studentToken,
    body: { studentId: String(student._id), reason: LONG_REASON },
  });
  checkEqual('a student cannot raise an escalation', asStudent.status, 403);

  const asTeacher = await api('POST', '/escalations', {
    token: teacherToken,
    body: { studentId: String(student._id), reason: LONG_REASON },
  });
  checkEqual('a teacher cannot raise an escalation', asTeacher.status, 403);

  const notMyClient = await api('POST', '/escalations', {
    token: counsellorToken,
    body: { studentId: String(otherStudent._id), reason: LONG_REASON },
  });
  checkEqual(
    'a counsellor cannot escalate another counsellor’s client',
    notMyClient.status,
    403,
  );

  const tooShort = await api('POST', '/escalations', {
    token: counsellorToken,
    body: { studentId: String(student._id), reason: 'too short' },
  });
  checkEqual('a thin reason is rejected', tooShort.status, 400);

  /* ---------------------------------------------------------------- create */

  const created = await api('POST', '/escalations', {
    token: counsellorToken,
    body: {
      studentId: String(student._id),
      reason: LONG_REASON,
      urgency: 'high',
    },
  });
  checkEqual('counsellor escalates their own client', created.status, 201);
  checkEqual('escalation starts pending', created.body?.data?.status, 'pending');
  checkEqual(
    'classroom is snapshotted at filing time',
    created.body?.data?.classroomSnapshot?.grade,
    '8',
  );

  const escalationId = created.body?.data?.id;
  const stored = await Escalation.findById(escalationId);
  checkEqual('urgencyRank is derived from urgency', stored?.urgencyRank, 3);
  checkEqual(
    'openKey is set while the case is open',
    String(stored?.openKey),
    String(student._id),
  );

  const duplicate = await api('POST', '/escalations', {
    token: otherCounsellorToken,
    body: { studentId: String(student._id), reason: LONG_REASON },
  });
  check(
    'a second open escalation for the same student is refused',
    duplicate.status === 409 || duplicate.status === 403,
    `got ${duplicate.status}`,
  );

  /* ---------------------------------------------------------- admin inbox */

  const foreignInbox = await api('GET', '/escalations/inbox', {
    token: foreignAdminToken,
  });
  checkEqual('another school’s admin gets a clean inbox', foreignInbox.body?.data?.length, 0);

  const inbox = await api('GET', '/escalations/inbox', { token: adminToken });
  checkEqual('school admin sees the escalation', inbox.body?.data?.length, 1);
  checkEqual(
    'admin inbox names the raising counsellor',
    inbox.body?.data?.[0]?.counsellor?.name,
    'Esc Counsellor',
  );

  const counts = await api('GET', '/escalations/inbox/counts', { token: adminToken });
  checkEqual('counts report one open case', counts.body?.data?.open, 1);
  checkEqual('counts flag it as urgent', counts.body?.data?.urgentOpen, 1);

  const counsellorInbox = await api('GET', '/escalations/inbox', {
    token: counsellorToken,
  });
  checkEqual('a counsellor cannot read the admin inbox', counsellorInbox.status, 403);

  const foreignDetail = await api('GET', `/escalations/inbox/${escalationId}`, {
    token: foreignAdminToken,
  });
  checkEqual(
    'another school’s admin cannot open the case',
    foreignDetail.status,
    404,
  );

  /* ------------------------------------------------------------ access log */

  const detail = await api('GET', `/escalations/inbox/${escalationId}`, {
    token: adminToken,
  });
  checkEqual('admin can open the case', detail.status, 200);

  const afterView = await Escalation.findById(escalationId).lean();
  checkEqual('opening the case writes an access log entry', afterView.accessLog?.length, 1);
  checkEqual(
    'access log records the viewer role',
    afterView.accessLog?.[0]?.viewerRole,
    'school_admin',
  );

  /* ----------------------------------------------- the confidentiality split */

  const withNotes = await api('PATCH', `/escalations/${escalationId}/status`, {
    token: adminToken,
    body: {
      status: 'acknowledged',
      adminNotes: 'Father has a history with the school; handle via the principal.',
      summaryForCounsellor: 'We have this. Will contact the family this week.',
    },
  });
  checkEqual('admin can acknowledge', withNotes.status, 200);
  checkEqual(
    'admin projection includes adminNotes',
    typeof withNotes.body?.data?.adminNotes,
    'string',
  );

  const mine = await api('GET', '/escalations/mine', { token: counsellorToken });
  const mineRow = mine.body?.data?.[0];
  checkEqual('counsellor sees their escalation', mine.body?.data?.length, 1);
  checkEqual('counsellor sees the status', mineRow?.status, 'acknowledged');
  checkEqual(
    'counsellor sees the shareable summary',
    mineRow?.summaryForCounsellor,
    'We have this. Will contact the family this week.',
  );
  check(
    'counsellor NEVER sees adminNotes',
    !('adminNotes' in (mineRow || {})),
    `counsellor payload keys: ${Object.keys(mineRow || {}).join(', ')}`,
  );
  check(
    'counsellor NEVER sees statusHistory notes',
    !('statusHistory' in (mineRow || {})),
    `counsellor payload keys: ${Object.keys(mineRow || {}).join(', ')}`,
  );

  /* -------------------------------------------------------- parent contact */

  const badMethod = await api('POST', `/escalations/${escalationId}/parent-contact`, {
    token: adminToken,
    body: { method: 'carrier_pigeon' },
  });
  checkEqual('an unknown contact method is rejected', badMethod.status, 400);

  const contacted = await api('POST', `/escalations/${escalationId}/parent-contact`, {
    token: adminToken,
    body: {
      method: 'phone',
      outcome: 'Spoke with mother; she will come in on Friday.',
      summaryForCounsellor: 'Parents informed, meeting Friday.',
    },
  });
  checkEqual('admin records parent contact', contacted.status, 200);
  checkEqual(
    'recording contact advances the status',
    contacted.body?.data?.status,
    'parent_contacted',
  );

  const mineAfter = await api('GET', '/escalations/mine', { token: counsellorToken });
  const row = mineAfter.body?.data?.[0];
  checkEqual('counsellor learns the parents were contacted', row?.parentContacted, true);
  check(
    'counsellor does NOT see the parent-conversation outcome',
    !JSON.stringify(row || {}).includes('Spoke with mother'),
    `leaked into: ${JSON.stringify(row)}`,
  );

  /* ---------------------------------------------------------------- close */

  const closed = await api('PATCH', `/escalations/${escalationId}/status`, {
    token: adminToken,
    body: { status: 'closed' },
  });
  checkEqual('admin closes the case', closed.status, 200);

  const closedDoc = await Escalation.findById(escalationId).lean();
  checkEqual('closing clears openKey', closedDoc.openKey, null);

  const reopenable = await api('POST', '/escalations', {
    token: counsellorToken,
    body: { studentId: String(student._id), reason: LONG_REASON },
  });
  checkEqual(
    'a new escalation can be raised once the previous one is closed',
    reopenable.status,
    201,
  );
};
