// §6 — referrals record who opened the case, not just whether anyone did.

const jwt = require('jsonwebtoken');
const { api, check, checkEqual, suite } = require('./harness');

const User = require('../../models/userModel');
const Organization = require('../../models/organizationModel');
const Classroom = require('../../models/classroomModel');
const Referral = require('../../models/referralModel');
const { ACCESS_LOG_CAP } = require('../../utils/accessLog');

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
  suite('§6  referral access audit');

  const counsellor = await mkUser({
    name: 'Audit Counsellor',
    email: 'audit.counsellor@smoke.test',
    role: 'therapist',
  });

  const org = await Organization.create({
    organizationName: 'Audit School',
    status: 'active',
    joinCode: 'SMOKE5',
    therapistRoster: [counsellor._id],
  });

  const teacher = await mkUser({
    name: 'Audit Teacher',
    email: 'audit.teacher@smoke.test',
    role: 'teacher',
    organization: org._id,
  });

  const classroom = await Classroom.create({
    organization: org._id,
    name: 'Grade 7',
    grade: '7',
    section: 'A',
    academicYear: '2026-27',
    teachers: [teacher._id],
    homeTeacher: teacher._id,
  });

  const student = await mkUser({
    name: 'Audit Student',
    email: 'audit.student@smoke.test',
    role: 'user',
    organization: org._id,
    classroom: classroom._id,
    assignedTherapist: counsellor._id,
  });

  const teacherToken = tokenFor(teacher);
  const counsellorToken = tokenFor(counsellor);

  /* ------------------------------------------------------- file a referral */

  const filed = await api('POST', '/referrals', {
    token: teacherToken,
    body: {
      studentId: String(student._id),
      reason: 'Withdrawn in class for the past three weeks and skipping group work.',
      concernTags: ['withdrawn_isolated'],
      urgency: 'medium',
    },
  });
  checkEqual('teacher files a referral', filed.status, 201);
  const referralId = filed.body?.data?.id;

  const fresh = await Referral.findById(referralId).lean();
  checkEqual('a new referral has an empty access log', (fresh.accessLog || []).length, 0);

  /* ------------------------------------------------- teacher opens the case */

  const teacherView = await api('GET', `/referrals/${referralId}`, {
    token: teacherToken,
  });
  checkEqual('teacher can open their own referral', teacherView.status, 200);

  const afterTeacher = await Referral.findById(referralId).lean();
  checkEqual('teacher view is logged', (afterTeacher.accessLog || []).length, 1);
  checkEqual(
    'log records the teacher role',
    afterTeacher.accessLog[0].viewerRole,
    'teacher',
  );
  checkEqual(
    'log records which teacher',
    String(afterTeacher.accessLog[0].viewer),
    String(teacher._id),
  );

  /* ---------------------------------------------- counsellor opens the case */

  const counsellorView = await api('GET', `/referrals/inbox/${referralId}`, {
    token: counsellorToken,
  });
  checkEqual('counsellor can open the referral', counsellorView.status, 200);

  const afterCounsellor = await Referral.findById(referralId).lean();
  checkEqual(
    'counsellor view is appended, not replaced',
    (afterCounsellor.accessLog || []).length,
    2,
  );
  checkEqual(
    'log records the therapist role',
    afterCounsellor.accessLog[1].viewerRole,
    'therapist',
  );

  /* ----------------------------------------------------- surfaced to the UI */

  const secondTeacherView = await api('GET', `/referrals/${referralId}`, {
    token: teacherToken,
  });
  const teacherLog = secondTeacherView.body?.data?.accessLog || [];
  check(
    'teacher payload surfaces the access log',
    teacherLog.length >= 2,
    `got ${teacherLog.length} entries`,
  );
  check(
    'teacher payload withholds viewer ids',
    teacherLog.every((entry) => !('viewer' in entry)),
    `entry keys: ${Object.keys(teacherLog[0] || {}).join(', ')}`,
  );

  const secondCounsellorView = await api('GET', `/referrals/inbox/${referralId}`, {
    token: counsellorToken,
  });
  const counsellorLog = secondCounsellorView.body?.data?.accessLog || [];
  check(
    'counsellor payload includes viewer ids',
    counsellorLog.every((entry) => 'viewer' in entry),
    `entry keys: ${Object.keys(counsellorLog[0] || {}).join(', ')}`,
  );

  /* ------------------------------------------------------------ the cap holds */

  const filler = Array.from({ length: ACCESS_LOG_CAP + 10 }, () => ({
    viewer: teacher._id,
    viewerRole: 'teacher',
    at: new Date(),
  }));
  await Referral.updateOne({ _id: referralId }, { $set: { accessLog: filler } });

  await api('GET', `/referrals/${referralId}`, { token: teacherToken });

  const capped = await Referral.findById(referralId).lean();
  checkEqual(
    `access log is capped at ${ACCESS_LOG_CAP} entries`,
    capped.accessLog.length,
    ACCESS_LOG_CAP,
  );
};
