// §3 — students are assigned a counsellor by classroom, never by choice.

const jwt = require('jsonwebtoken');
const { api, check, checkEqual, suite } = require('./harness');

const User = require('../../models/userModel');
const Organization = require('../../models/organizationModel');
const Classroom = require('../../models/classroomModel');
const ClassroomTransferRequest = require('../../models/classroomTransferRequestModel');

const tokenFor = (user) =>
  jwt.sign(
    { id: String(user._id), sessionVersion: Number(user.sessionVersion || 0) },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN },
  );

const mkUser = (over = {}) =>
  User.create({
    name: 'T',
    password: 'test-password-1',
    passwordConfirm: 'test-password-1',
    ...over,
  });

module.exports = async () => {
  suite('§3  classroom-assigned counsellor');

  /* ---------------------------------------------------------------- setup */

  const counsellorA = await mkUser({
    name: 'Counsellor A',
    email: 'c.a@smoke.test',
    role: 'therapist',
  });
  const counsellorB = await mkUser({
    name: 'Counsellor B',
    email: 'c.b@smoke.test',
    role: 'therapist',
  });
  const offRoster = await mkUser({
    name: 'Off Roster',
    email: 'c.off@smoke.test',
    role: 'therapist',
  });

  const org = await Organization.create({
    organizationName: 'Counsellor Mapping School',
    status: 'active',
    joinCode: 'SMOKE1',
    therapistRoster: [counsellorA._id, counsellorB._id],
  });

  const otherOrg = await Organization.create({
    organizationName: 'Other School',
    status: 'active',
    joinCode: 'SMOKE2',
    therapistRoster: [counsellorA._id],
  });

  const nine = await Classroom.create({
    organization: org._id,
    name: 'Grade 9',
    grade: '9',
    section: 'A',
    academicYear: '2026-27',
  });
  const ten = await Classroom.create({
    organization: org._id,
    name: 'Grade 10',
    grade: '10',
    section: 'A',
    academicYear: '2026-27',
    assignedCounsellor: counsellorB._id,
  });
  const foreignClassroom = await Classroom.create({
    organization: otherOrg._id,
    name: 'Foreign Grade 9',
    grade: '9',
    section: 'Z',
    academicYear: '2026-27',
  });

  const platformAdmin = await mkUser({
    name: 'Platform Admin',
    email: 'admin.c@smoke.test',
    role: 'admin',
  });
  const adminToken = tokenFor(platformAdmin);

  const schoolAdmin = await mkUser({
    name: 'School Admin',
    email: 'schooladmin.c@smoke.test',
    role: 'school_admin',
    organization: org._id,
  });
  const schoolAdminToken = tokenFor(schoolAdmin);

  /* --------------------------------------------------- setting a counsellor */

  const offRosterAttempt = await api('PATCH', `/classrooms/${nine._id}/counsellor`, {
    token: adminToken,
    body: { counsellorUserId: String(offRoster._id) },
  });
  checkEqual(
    'counsellor not on the school roster is rejected',
    offRosterAttempt.status,
    400,
  );

  const notATherapist = await api('PATCH', `/classrooms/${nine._id}/counsellor`, {
    token: adminToken,
    body: { counsellorUserId: String(platformAdmin._id) },
  });
  checkEqual('a non-therapist is rejected as counsellor', notATherapist.status, 400);

  const setOk = await api('PATCH', `/classrooms/${nine._id}/counsellor`, {
    token: adminToken,
    body: { counsellorUserId: String(counsellorA._id) },
  });
  checkEqual('admin can set a rostered counsellor', setOk.status, 200);

  const nineAfter = await Classroom.findById(nine._id);
  checkEqual(
    'classroom stores assignedCounsellor',
    String(nineAfter.assignedCounsellor),
    String(counsellorA._id),
  );

  /* ------------------------------------------------ cross-school protection */

  const crossSchool = await api(
    'PATCH',
    `/classrooms/${foreignClassroom._id}/counsellor`,
    {
      token: schoolAdminToken,
      body: { counsellorUserId: String(counsellorA._id) },
    },
  );
  checkEqual(
    'school_admin cannot set a counsellor on another school',
    crossSchool.status,
    404,
  );

  const ownSchool = await api('PATCH', `/classrooms/${ten._id}/counsellor`, {
    token: schoolAdminToken,
    body: { counsellorUserId: String(counsellorB._id) },
  });
  checkEqual(
    'school_admin can set a counsellor in their own school',
    ownSchool.status,
    200,
  );

  /* ------------------------------------------------------ join inherits it */

  const student = await mkUser({
    name: 'Joining Student',
    email: 'student.join@smoke.test',
    role: 'user',
    organization: org._id,
  });
  const studentToken = tokenFor(student);

  const joined = await api('POST', `/classrooms/${nine._id}/join`, {
    token: studentToken,
  });
  checkEqual('student joins the classroom', joined.status, 200);

  const joinedStudent = await User.findById(student._id);
  checkEqual(
    'joining a classroom assigns its counsellor',
    String(joinedStudent.assignedTherapist),
    String(counsellorA._id),
  );

  /* ------------------------------------------------- choice is switched off */

  const choice = await api('POST', '/users/select-organization-therapist', {
    token: studentToken,
    body: { therapistUserId: String(counsellorB._id) },
  });
  checkEqual('student can no longer choose a counsellor', choice.status, 410);

  const unchanged = await User.findById(student._id);
  checkEqual(
    'the refused choice did not change the assignment',
    String(unchanged.assignedTherapist),
    String(counsellorA._id),
  );

  const roster = await api('GET', '/organizations/my-therapist-roster', {
    token: studentToken,
  });
  checkEqual('roster endpoint still responds', roster.status, 200);
  checkEqual(
    'roster returns only the assigned counsellor, not the directory',
    roster.body?.data?.roster?.length,
    1,
  );
  checkEqual(
    'roster reports school_assigned mode',
    roster.body?.data?.assignmentMode,
    'school_assigned',
  );

  /* --------------------------------------------- transfer moves the counsellor */

  const homeTeacher = await mkUser({
    name: 'Home Teacher',
    email: 'home.c@smoke.test',
    role: 'teacher',
    organization: org._id,
  });
  nineAfter.homeTeacher = homeTeacher._id;
  await nineAfter.save();

  const transfer = await ClassroomTransferRequest.create({
    student: student._id,
    organization: org._id,
    fromClassroom: nine._id,
    toClassroom: ten._id,
    status: 'pending',
  });

  const decided = await api('PATCH', `/classroom-transfers/${transfer._id}`, {
    token: tokenFor(homeTeacher),
    body: { decision: 'approved' },
  });
  checkEqual('home teacher approves the transfer', decided.status, 200);

  const moved = await User.findById(student._id);
  checkEqual(
    'transfer moved the student to the new classroom',
    String(moved.classroom),
    String(ten._id),
  );
  checkEqual(
    'counsellor follows the student to the new classroom',
    String(moved.assignedTherapist),
    String(counsellorB._id),
  );

  /* ------------------------------------- re-pointing a classroom's counsellor */

  const stayer = await mkUser({
    name: 'Stayer',
    email: 'stayer@smoke.test',
    role: 'user',
    organization: org._id,
    classroom: ten._id,
    assignedTherapist: counsellorB._id,
  });
  const overridden = await mkUser({
    name: 'Overridden',
    email: 'overridden@smoke.test',
    role: 'user',
    organization: org._id,
    classroom: ten._id,
    assignedTherapist: counsellorA._id, // individually re-assigned earlier
  });

  const repoint = await api('PATCH', `/classrooms/${ten._id}/counsellor`, {
    token: schoolAdminToken,
    body: { counsellorUserId: String(counsellorA._id) },
  });
  checkEqual('classroom counsellor can be changed', repoint.status, 200);

  const stayerAfter = await User.findById(stayer._id);
  checkEqual(
    'students on the old counsellor are re-pointed',
    String(stayerAfter.assignedTherapist),
    String(counsellorA._id),
  );

  const overriddenAfter = await User.findById(overridden._id);
  checkEqual(
    'an individually overridden student keeps their counsellor',
    String(overriddenAfter.assignedTherapist),
    String(counsellorA._id),
  );
  check(
    're-point reported a count',
    typeof repoint.body?.data?.studentsReassigned === 'number',
    `got ${JSON.stringify(repoint.body?.data?.studentsReassigned)}`,
  );
};
