/* eslint-disable no-console */
// Idempotent local seed for the teacher / classroom / referral feature.
//   npm run seed:classrooms
//
// Prints the seeded teacher invite email — sign up with it through the real
// /users/signup endpoint to exercise the actual provisioning path.
const dotenv = require('dotenv');
const mongoose = require('mongoose');

dotenv.config({ path: './config.env' });

const User = require('../models/userModel');
const Organization = require('../models/organizationModel');
const Classroom = require('../models/classroomModel');
const Referral = require('../models/referralModel');
const TeacherInvite = require('../models/teacherInviteModel');
const ClassroomTransferRequest = require('../models/classroomTransferRequestModel');

const ORG_NAME = 'Zen Test School';
const JOIN_CODE = 'ZENTEST';
const YEAR = '2025-26';
const TEACHER_INVITE_EMAIL = 'teacher.invited@zentest.school';
const HOME_TEACHER_EMAIL = 'home.teacher@zentest.school';
const SEED_PASSWORD = 'zengarden123';

const STUDENT_NAMES = [
  'Aarav Sharma',
  'Ishita Rao',
  'Kabir Menon',
  'Diya Nair',
  'Rohan Gupta',
  'Ananya Iyer',
  'Vihaan Reddy',
  'Meera Joshi',
  'Arjun Kulkarni',
  'Saanvi Bose',
  'Neel Chatterjee',
  'Tara Pillai',
];

// insertMany would skip the bcrypt pre('save') hook, and passwordConfirm is a
// required field, so every user here goes through new User(...) + .save().
const upsertUser = async ({ name, email, role, extra = {} }) => {
  let user = await User.findOne({ email });
  if (!user) {
    user = new User({
      name,
      email,
      password: SEED_PASSWORD,
      passwordConfirm: SEED_PASSWORD,
      role,
    });
  }
  user.name = name;
  user.role = role;
  Object.assign(user, extra);
  await user.save({ validateBeforeSave: !user.isNew ? false : undefined });
  return user;
};

const run = async () => {
  if (!process.env.DATABASE) {
    throw new Error('DATABASE is not set in config.env');
  }
  await mongoose.connect(process.env.DATABASE);
  console.log('connected\n');

  // 1. Organization
  let org = await Organization.findOne({ organizationName: ORG_NAME });
  if (!org) {
    org = await Organization.create({
      organizationName: ORG_NAME,
      joinCode: JOIN_CODE,
      joinCodeActive: true,
    });
  }
  console.log(`org           ${org.organizationName}  (join code ${JOIN_CODE})`);

  // 2. A therapist ON THE ROSTER. Without this the inbox is empty and 403s, and
  //    it looks like the referral code is broken.
  let therapist = await User.findOne({ role: 'therapist' });
  if (!therapist) {
    therapist = await upsertUser({
      name: 'Dr. Priya Mehta',
      email: 'therapist@zentest.school',
      role: 'therapist',
    });
    console.log('therapist     created therapist@zentest.school');
  }
  await Organization.updateOne(
    { _id: org._id },
    { $addToSet: { therapistRoster: therapist._id } },
  );
  console.log(`therapist     ${therapist.email} is on the roster`);

  // 3. Home teacher (pre-made, so transfer approval is testable immediately)
  const homeTeacher = await upsertUser({
    name: 'Mr. Sanjay Verma',
    email: HOME_TEACHER_EMAIL,
    role: 'teacher',
    extra: { organization: org._id, classroom: null },
  });

  // 4. Classrooms
  const classrooms = {};
  for (const [grade, section] of [
    ['Grade 9', 'A'],
    ['Grade 9', 'B'],
  ]) {
    const name = `${grade} - ${section}`;
    let classroom = await Classroom.findOne({
      organization: org._id,
      name,
      academicYear: YEAR,
    });
    if (!classroom) {
      classroom = new Classroom({
        organization: org._id,
        name,
        grade,
        section,
        academicYear: YEAR,
      });
    }
    if (section === 'B') classroom.homeTeacher = homeTeacher._id;
    await classroom.save();
    classrooms[section] = classroom;
    console.log(
      `classroom     ${name}${section === 'B' ? `  (home teacher ${homeTeacher.email})` : ''}`,
    );
  }

  // 5. Students, split across both classes
  let studentCount = 0;
  for (let i = 0; i < STUDENT_NAMES.length; i += 1) {
    const name = STUDENT_NAMES[i];
    const slug = name.toLowerCase().replace(/[^a-z]+/g, '.');
    const section = i % 2 === 0 ? 'A' : 'B';
    await upsertUser({
      name,
      email: `${slug}@zentest.school`,
      role: 'user',
      extra: { organization: org._id, classroom: classrooms[section]._id },
    });
    studentCount += 1;
  }
  console.log(`students      ${studentCount} across Grade 9 - A and Grade 9 - B`);

  // 6. The teacher invite — this is the provisioning path worth testing
  const existingInvite = await TeacherInvite.findOne({
    email: TEACHER_INVITE_EMAIL,
  });
  if (!existingInvite) {
    await TeacherInvite.create({
      organization: org._id,
      email: TEACHER_INVITE_EMAIL,
      name: 'Ms. Rhea Kapoor',
      status: 'pending',
      defaultClassrooms: [classrooms.A._id, classrooms.B._id],
      source: 'admin_manual',
    });
  }

  // 7. Index integrity. A partial unique index that fails to build does so
  //    silently in the background, which is exactly what would let duplicate open
  //    referrals through.
  const indexed = await Promise.all([
    Classroom.syncIndexes(),
    Referral.syncIndexes(),
    TeacherInvite.syncIndexes(),
    ClassroomTransferRequest.syncIndexes(),
    User.syncIndexes(),
  ]);
  console.log('\nindexes       synced OK', JSON.stringify(indexed));

  console.log('\n--- sign in with these -------------------------------------');
  console.log(`  teacher invite (NOT yet an account): ${TEACHER_INVITE_EMAIL}`);
  console.log('      POST /api/v1/users/signup with that email to claim it');
  console.log(`  existing teacher:  ${HOME_TEACHER_EMAIL} / ${SEED_PASSWORD}`);
  console.log(`  therapist:         ${therapist.email} / ${SEED_PASSWORD}`);
  console.log(`  student:           aarav.sharma@zentest.school / ${SEED_PASSWORD}`);
  console.log(`  org join code:     ${JOIN_CODE}`);
  console.log('------------------------------------------------------------');

  const admin = await User.findOne({ role: 'admin' }).select('email').lean();
  if (!admin) {
    console.log(
      '\nNOTE: no admin user exists, so the admin-only classroom and invite\n' +
        '      endpoints cannot be called yet. Promote one in mongo:\n' +
        "      db.users.updateOne({email:'you@x.com'},{$set:{role:'admin'}})",
    );
  } else {
    console.log(`\nadmin         ${admin.email}`);
  }

  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error('\nseed failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
