// §1 — school_admin role, provisioned from a staff invite.

const jwt = require('jsonwebtoken');
const { api, check, checkEqual, suite } = require('./harness');

const User = require('../../models/userModel');
const Organization = require('../../models/organizationModel');
const Classroom = require('../../models/classroomModel');
const TeacherInvite = require('../../models/teacherInviteModel');
const { requireSchoolAdminOrg } = require('../../utils/orgScope');

const tokenFor = (user) =>
  jwt.sign(
    { id: String(user._id), sessionVersion: Number(user.sessionVersion || 0) },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN },
  );

module.exports = async () => {
  suite('§1  school_admin role');

  /* ---------------------------------------------------------------- setup */

  const org = await Organization.create({
    organizationName: 'Smoke Test School',
    city: 'Jaipur',
    status: 'active',
  });

  const classroom = await Classroom.create({
    organization: org._id,
    name: 'Grade 9',
    grade: '9',
    section: 'B',
    academicYear: '2026-27',
  });

  const platformAdmin = await User.create({
    name: 'Platform Admin',
    email: 'platform.admin@smoke.test',
    password: 'test-password-1',
    passwordConfirm: 'test-password-1',
    role: 'admin',
  });
  const adminToken = tokenFor(platformAdmin);

  /* ------------------------------------------------- model accepts the role */

  const direct = await User.create({
    name: 'Direct School Admin',
    email: 'direct.schooladmin@smoke.test',
    password: 'test-password-1',
    passwordConfirm: 'test-password-1',
    role: 'school_admin',
  });
  checkEqual('User model accepts role school_admin', direct.role, 'school_admin');
  check(
    'roles[] syncs school_admin via pre-save hook',
    direct.roles.includes('school_admin'),
    `roles = ${JSON.stringify(direct.roles)}`,
  );

  /* --------------------------------------------- invite creation with role */

  const invited = await api('POST', '/teacher-invites', {
    token: adminToken,
    body: {
      organizationId: String(org._id),
      role: 'school_admin',
      entries: [{ email: 'head@smoke.test', name: 'Head of School' }],
    },
  });
  checkEqual('admin can create a school_admin invite', invited.status, 201);
  checkEqual('invite was created', invited.body?.data?.created, 1);

  const savedInvite = await TeacherInvite.findOne({ email: 'head@smoke.test' });
  checkEqual('invite persists role=school_admin', savedInvite?.role, 'school_admin');

  const teacherInvited = await api('POST', '/teacher-invites', {
    token: adminToken,
    body: {
      organizationId: String(org._id),
      entries: [{ email: 'teach@smoke.test', name: 'Class Teacher' }],
      classroomIds: [String(classroom._id)],
    },
  });
  checkEqual('teacher invite still works', teacherInvited.status, 201);
  const teacherInviteRow = await TeacherInvite.findOne({ email: 'teach@smoke.test' });
  checkEqual(
    'invite role defaults to teacher when unspecified',
    teacherInviteRow?.role,
    'teacher',
  );

  /* ----------------------------------------------- signup resolves the role */

  const adminSignup = await api('POST', '/users/signup', {
    body: {
      name: 'Head of School',
      email: 'head@smoke.test',
      password: 'test-password-1',
      passwordConfirm: 'test-password-1',
      intent: 'school_admin',
    },
  });
  checkEqual('school_admin signup succeeds', adminSignup.status, 201);
  checkEqual(
    'signup returns role school_admin',
    adminSignup.body?.data?.user?.role,
    'school_admin',
  );

  const headUser = await User.findOne({ email: 'head@smoke.test' });
  checkEqual('school_admin persisted with role', headUser?.role, 'school_admin');
  checkEqual(
    'school_admin is bound to the inviting organization',
    String(headUser?.organization || ''),
    String(org._id),
  );

  /* ------------------------------- school_admin must NOT join classroom staff */

  const adminWithClassroomInvite = await api('POST', '/teacher-invites', {
    token: adminToken,
    body: {
      organizationId: String(org._id),
      role: 'school_admin',
      entries: [{ email: 'head2@smoke.test', name: 'Deputy Head' }],
      classroomIds: [String(classroom._id)],
    },
  });
  checkEqual('deputy invite created', adminWithClassroomInvite.status, 201);

  await api('POST', '/users/signup', {
    body: {
      name: 'Deputy Head',
      email: 'head2@smoke.test',
      password: 'test-password-1',
      passwordConfirm: 'test-password-1',
      intent: 'school_admin',
    },
  });
  const deputy = await User.findOne({ email: 'head2@smoke.test' });
  const classroomAfter = await Classroom.findById(classroom._id);
  check(
    'school_admin is NOT added to classroom teachers[]',
    !classroomAfter.teachers.some((t) => String(t) === String(deputy._id)),
    `teachers = ${JSON.stringify(classroomAfter.teachers.map(String))}`,
  );

  await api('POST', '/users/signup', {
    body: {
      name: 'Class Teacher',
      email: 'teach@smoke.test',
      password: 'test-password-1',
      passwordConfirm: 'test-password-1',
      intent: 'teacher',
    },
  });
  const teacherUser = await User.findOne({ email: 'teach@smoke.test' });
  const classroomWithTeacher = await Classroom.findById(classroom._id);
  checkEqual('teacher signup still resolves role teacher', teacherUser?.role, 'teacher');
  check(
    'teacher IS added to classroom teachers[]',
    classroomWithTeacher.teachers.some((t) => String(t) === String(teacherUser._id)),
    `teachers = ${JSON.stringify(classroomWithTeacher.teachers.map(String))}`,
  );

  /* ----------------------------------------------- uninvited staff is refused */

  const uninvited = await api('POST', '/users/signup', {
    body: {
      name: 'Nobody',
      email: 'nobody@smoke.test',
      password: 'test-password-1',
      passwordConfirm: 'test-password-1',
      intent: 'school_admin',
    },
  });
  checkEqual('uninvited school_admin signup is refused', uninvited.status, 403);
  const nobody = await User.findOne({ email: 'nobody@smoke.test' });
  check('refused signup created no account', !nobody);

  /* -------------------------------------------- a student cannot self-assert */

  const selfAsserted = await api('POST', '/users/signup', {
    body: {
      name: 'Sneaky Student',
      email: 'sneaky@smoke.test',
      password: 'test-password-1',
      passwordConfirm: 'test-password-1',
      role: 'school_admin',
    },
  });
  checkEqual('signup with role in body succeeds', selfAsserted.status, 201);
  const sneaky = await User.findOne({ email: 'sneaky@smoke.test' });
  checkEqual(
    'client-asserted school_admin is downgraded to user',
    sneaky?.role,
    'user',
  );

  /* ------------------------------------------------- requireSchoolAdminOrg */

  checkEqual(
    'requireSchoolAdminOrg returns the org for a school_admin',
    String(requireSchoolAdminOrg(headUser)),
    String(org._id),
  );

  let threwForTeacher = false;
  try {
    requireSchoolAdminOrg(teacherUser);
  } catch (err) {
    threwForTeacher = err.statusCode === 403;
  }
  check('requireSchoolAdminOrg rejects a teacher with 403', threwForTeacher);

  let threwForOrphan = false;
  try {
    requireSchoolAdminOrg({ role: 'school_admin', roles: ['school_admin'] });
  } catch (err) {
    threwForOrphan = err.statusCode === 400;
  }
  check(
    'requireSchoolAdminOrg rejects a school_admin with no organization',
    threwForOrphan,
  );

  /* --------------------------------- the signup token must actually work */

  const issuedToken = adminSignup.body?.data?.token;
  const me = await api('GET', '/users/me', { token: issuedToken });
  checkEqual('token issued at signup authenticates against /users/me', me.status, 200);
  checkEqual(
    '/users/me reports the school_admin role',
    me.body?.data?.role,
    'school_admin',
  );
};
