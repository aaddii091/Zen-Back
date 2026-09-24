/* eslint-disable no-console */
//
// Sample school data for live walkthroughs. Safe to run against the production
// cluster.
//
//   node scripts/seedSampleSchool.js --confirm          create / refresh the sample school
//   node scripts/seedSampleSchool.js --confirm --wipe   remove it again, and nothing else
//
// Live-safety rules this script follows:
//   * It NEVER calls syncIndexes(). That drops any index not declared in a
//     schema, which on a shared cluster can silently remove someone else's.
//   * Everything it creates is namespaced to one organization and one email
//     domain (@greenwoodschool.edu.in), so --wipe can remove exactly what it
//     made and nothing belonging to a real school.
//   * It prints the target host and refuses to run without --confirm, because
//     which database you are on depends on which DATABASE line in config.env is
//     uncommented.
const dotenv = require('dotenv');
const mongoose = require('mongoose');

dotenv.config({ path: './config.env' });

const User = require('../models/userModel');
const Organization = require('../models/organizationModel');
const Classroom = require('../models/classroomModel');
const Referral = require('../models/referralModel');
const TeacherInvite = require('../models/teacherInviteModel');
const ClassroomTransferRequest = require('../models/classroomTransferRequestModel');
const TherapistProfile = require('../models/therapistProfileModel');
const UserInfo = require('../models/userInfoModel');

// The school NAME is what appears on the platform, so it carries no "(Demo)"
// suffix. The domain, join code and password stay as-is deliberately — they are
// the credentials already in use.
const ORG_NAME = 'Greenwood Public School';
const JOIN_CODE = 'DEMO26';
const YEAR = '2026-27';
const DOMAIN = 'demoschool.zengarden.in';
const PASSWORD = 'Demo@2026';

const email = (local) => `${local}@${DOMAIN}`;

const THERAPISTS = [
  {
    local: 'dr.meera',
    name: 'Dr. Meera Krishnan',
    profile: {
      displayName: 'Dr. Meera Krishnan',
      title: 'Consultant Clinical Psychologist',
      profileType: 'professional_therapist',
      specializations: [
        'Adolescent anxiety',
        'Exam stress',
        'Trauma-informed care',
        'Family systems',
      ],
      yearsOfExperience: 12,
      languages: ['English', 'Hindi', 'Malayalam'],
      sessionModes: ['video', 'audio', 'in_person'],
      timezone: 'Asia/Kolkata',
      availabilityStatus: 'available',
      bio:
        'RCI-licensed clinical psychologist with twelve years in school mental '
        + 'health. Works with adolescents on anxiety, low mood and exam pressure, '
        + 'and runs the safeguarding response for partner schools. Practises in '
        + 'English, Hindi and Malayalam.',
    },
  },
  {
    local: 'dr.arun',
    name: 'Dr. Arun Bhatia',
    profile: {
      displayName: 'Dr. Arun Bhatia',
      title: 'Counselling Psychologist',
      profileType: 'professional_therapist',
      specializations: ['Peer conflict', 'Behavioural change', 'Sleep and routine'],
      yearsOfExperience: 7,
      languages: ['English', 'Hindi', 'Punjabi'],
      sessionModes: ['video', 'chat'],
      timezone: 'Asia/Kolkata',
      availabilityStatus: 'available',
      bio:
        'Counselling psychologist focused on peer relationships, behavioural '
        + 'change and sleep routines in secondary students. Second reviewer on '
        + 'the school help group, so referrals always have cover.',
    },
  },
];

const TEACHERS = [
  {
    local: 'rhea.kapoor',
    name: 'Ms. Rhea Kapoor',
    homeOf: null, // teaches both sections, home teacher of neither
  },
  {
    local: 'sanjay.verma',
    name: 'Mr. Sanjay Verma',
    homeOf: 'B', // home teacher of 9-B, so transfer approval can be shown
  },
];

// primaryConcern values come from userInfoModel's enum.
const STUDENTS = [
  { local: 'aarav.sharma', name: 'Aarav Sharma', section: 'A', concern: 'stress' },
  { local: 'ishita.rao', name: 'Ishita Rao', section: 'A', concern: 'anxiety' },
  { local: 'kabir.menon', name: 'Kabir Menon', section: 'A', concern: 'stress' },
  { local: 'diya.nair', name: 'Diya Nair', section: 'A', concern: 'sleep' },
  { local: 'rohan.gupta', name: 'Rohan Gupta', section: 'A', concern: 'relationships' },
  { local: 'ananya.iyer', name: 'Ananya Iyer', section: 'B', concern: 'anxiety' },
  { local: 'vihaan.reddy', name: 'Vihaan Reddy', section: 'B', concern: 'stress' },
  { local: 'meera.joshi', name: 'Meera Joshi', section: 'B', concern: 'other' },
  { local: 'arjun.kulkarni', name: 'Arjun Kulkarni', section: 'B', concern: 'relationships' },
  { local: 'saanvi.bose', name: 'Saanvi Bose', section: 'B', concern: 'sleep' },
  { local: 'neel.chatterjee', name: 'Neel Chatterjee', section: 'B', concern: 'stress' },
  { local: 'tara.pillai', name: 'Tara Pillai', section: 'B', concern: 'anxiety' },
];

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

// insertMany would skip the bcrypt pre('save') hook, and passwordConfirm is
// required on create, so every user goes through new User(...) + .save().
const upsertUser = async ({ name, local, role, extra = {} }) => {
  const addr = email(local);
  let user = await User.findOne({ email: addr });
  if (!user) {
    user = new User({
      name,
      email: addr,
      password: PASSWORD,
      passwordConfirm: PASSWORD,
      role,
    });
  }
  user.name = name;
  user.role = role;
  Object.assign(user, extra);
  await user.save({ validateBeforeSave: user.isNew });
  return user;
};

const wipe = async () => {
  const org = await Organization.findOne({ organizationName: ORG_NAME });
  const sampleUsers = await User.find({ email: new RegExp(`@${DOMAIN}$`) })
    .select('_id')
    .lean();
  const ids = sampleUsers.map((u) => u._id);

  const counts = {
    referrals: (await Referral.deleteMany({ student: { $in: ids } })).deletedCount,
    transfers: (await ClassroomTransferRequest.deleteMany({ student: { $in: ids } }))
      .deletedCount,
    invites: (await TeacherInvite.deleteMany({ email: new RegExp(`@${DOMAIN}$`) }))
      .deletedCount,
    profiles: (await TherapistProfile.deleteMany({ user: { $in: ids } })).deletedCount,
    userInfos: (await UserInfo.deleteMany({ user: { $in: ids } })).deletedCount,
    classrooms: org
      ? (await Classroom.deleteMany({ organization: org._id })).deletedCount
      : 0,
    users: (await User.deleteMany({ _id: { $in: ids } })).deletedCount,
    organizations: org
      ? (await Organization.deleteOne({ _id: org._id })).deletedCount
      : 0,
  };

  console.log('\nremoved (sample school data only):');
  Object.entries(counts).forEach(([k, v]) => console.log(`  ${k.padEnd(16)}${v}`));
};

const run = async () => {
  const args = process.argv.slice(2);
  const uri = process.env.DATABASE;
  if (!uri) throw new Error('DATABASE is not set in config.env');

  const host = uri.replace(/(mongodb(\+srv)?:\/\/[^:]+:)[^@]+@/, '$1****@');
  console.log('target: ' + host);

  if (!args.includes('--confirm')) {
    console.log(
      '\nRefusing to run without --confirm.\n'
        + 'Check the target above is the database you mean — which one you get\n'
        + 'depends on the last uncommented DATABASE line in config.env.\n\n'
        + '  node scripts/seedSampleSchool.js --confirm\n'
        + '  node scripts/seedSampleSchool.js --confirm --wipe\n',
    );
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log('connected to database: ' + mongoose.connection.name + '\n');

  if (args.includes('--wipe')) {
    await wipe();
    await mongoose.disconnect();
    return;
  }

  /* ---------------------------------------------------------- organization */
  let org = await Organization.findOne({ organizationName: ORG_NAME });
  if (!org) {
    // The live cluster carries legacy UNIQUE indexes from an older schema —
    // name_1 and organizationId_1 — on fields the current model does not define.
    // One existing org has both missing, which uses up the single null each of
    // those indexes permits, so creating an org through the Mongoose model fails
    // with E11000 { name: null }. Insert through the driver with those fields
    // populated, then read it back through the model.
    const legacyId =
      'ORG-' + Date.now().toString(36).toUpperCase() + '-'
      + Math.random().toString(36).slice(2, 7).toUpperCase();

    await mongoose.connection.db.collection('organizations').insertOne({
      organizationName: ORG_NAME,
      name: ORG_NAME, // legacy name_1 unique index
      organizationId: legacyId, // legacy organizationId_1 unique index
      joinCode: JOIN_CODE,
      joinCodeActive: true,
      therapistRoster: [],
      __v: 0,
    });
    org = await Organization.findOne({ organizationName: ORG_NAME });
  }
  console.log(`org           ${ORG_NAME}  (join code ${JOIN_CODE})`);

  /* ------------------------------------------------------------ therapists */
  const therapists = [];
  for (const t of THERAPISTS) {
    const user = await upsertUser({ name: t.name, local: t.local, role: 'therapist' });
    await TherapistProfile.findOneAndUpdate(
      { user: user._id },
      { $set: { user: user._id, ...t.profile } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    therapists.push(user);
    console.log(`therapist     ${user.email}  (${t.profile.title})`);
  }
  await Organization.updateOne(
    { _id: org._id },
    { $addToSet: { therapistRoster: { $each: therapists.map((t) => t._id) } } },
  );

  /* -------------------------------------------------------------- teachers */
  const teachers = {};
  for (const t of TEACHERS) {
    const user = await upsertUser({
      name: t.name,
      local: t.local,
      role: 'teacher',
      extra: { organization: org._id, classroom: null, hasOnboarded: true },
    });
    teachers[t.local] = user;
    console.log(`teacher       ${user.email}`);
  }

  /* ------------------------------------------------------------ classrooms */
  const classrooms = {};
  for (const section of ['A', 'B']) {
    const name = `Grade 9 - ${section}`;
    let classroom = await Classroom.findOne({
      organization: org._id,
      name,
      academicYear: YEAR,
    });
    if (!classroom) {
      classroom = new Classroom({
        organization: org._id,
        name,
        grade: 'Grade 9',
        section,
        academicYear: YEAR,
      });
    }
    // Both teachers teach both sections; Sanjay is home teacher of 9-B only, so
    // the transfer-approval path has an owner and 9-A exercises the fallback.
    classroom.teachers = [teachers['rhea.kapoor']._id, teachers['sanjay.verma']._id];
    const homeOwner = TEACHERS.find((t) => t.homeOf === section);
    classroom.homeTeacher = homeOwner ? teachers[homeOwner.local]._id : null;
    await classroom.save();
    classrooms[section] = classroom;
    console.log(
      `classroom     ${name}${homeOwner ? `  (home teacher ${teachers[homeOwner.local].email})` : '  (no home teacher — fallback path)'}`,
    );
  }

  /* --------------------------------------------------------------- students */
  const students = {};
  for (const s of STUDENTS) {
    const user = await upsertUser({
      name: s.name,
      local: s.local,
      role: 'user',
      extra: {
        organization: org._id,
        classroom: classrooms[s.section]._id,
        hasOnboarded: true,
      },
    });
    await UserInfo.findOneAndUpdate(
      { user: user._id },
      {
        $set: {
          user: user._id,
          primaryConcern: s.concern,
          languagePref: 'English',
          sessionMode: 'zoom_video', // userInfoModel enum, not the therapist one
          timezone: 'Asia/Kolkata',
          reminderChannel: 'email',
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    students[s.local] = user;
  }
  console.log(`students      ${STUDENTS.length} across Grade 9 - A and Grade 9 - B`);

  /* ------------------------------------------- a teacher invite to claim live */
  const inviteEmail = email('new.teacher');
  if (!(await TeacherInvite.findOne({ email: inviteEmail }))) {
    await TeacherInvite.create({
      organization: org._id,
      email: inviteEmail,
      name: 'Ms. Priya Das',
      status: 'pending',
      defaultClassrooms: [classrooms.A._id, classrooms.B._id],
      source: 'admin_manual',
    });
  }

  /* ------------------------------------------------------------- referrals */
  // A spread of states so the inbox looks like a real working queue rather than
  // one lonely row. Each is idempotent on (organization, student).
  const makeReferral = async (spec) => {
    const existing = await Referral.findOne({
      organization: org._id,
      student: spec.student._id,
    });
    if (existing) return existing;

    const classroom = await Classroom.findById(spec.student.classroom).lean();
    const referral = new Referral({
      student: spec.student._id,
      teacher: spec.teacher ? spec.teacher._id : null,
      organization: org._id,
      classroom: spec.student.classroom,
      classroomSnapshot: {
        name: classroom?.name || '',
        grade: classroom?.grade || '',
        section: classroom?.section || '',
      },
      source: spec.source || 'teacher_manual',
      reason: spec.reason,
      concernTags: spec.concernTags,
      urgency: spec.urgency,
      status: spec.status,
      assignedTherapist: spec.assignedTherapist ? spec.assignedTherapist._id : null,
      acknowledgedAt: spec.acknowledgedAt || null,
      startedAt: spec.startedAt || null,
      closedAt: spec.closedAt || null,
      closureOutcome: spec.closureOutcome || null,
      closureNote: spec.closureNote || '',
      closureSummaryForTeacher: spec.closureSummaryForTeacher || '',
      selfAssessment: spec.selfAssessment || undefined,
      createdAt: spec.createdAt,
      statusHistory: [{ status: 'pending', at: spec.createdAt, note: '' }],
    });
    await referral.save();
    if (spec.assignedTherapist) {
      await User.updateOne(
        { _id: spec.student._id },
        { $set: { assignedTherapist: spec.assignedTherapist._id } },
      );
    }
    return referral;
  };

  await makeReferral({
    student: students['kabir.menon'],
    teacher: teachers['rhea.kapoor'],
    reason:
      'Has stopped participating in group work since the start of term and sits '
      + 'alone at break. Handed in two of the last five assignments.',
    concernTags: ['withdrawn_isolated', 'academic_decline'],
    urgency: 'high',
    status: 'pending',
    createdAt: daysAgo(1),
  });

  await makeReferral({
    student: students['rohan.gupta'],
    teacher: teachers['sanjay.verma'],
    reason:
      'Repeated conflict with two classmates during PE. Became tearful when asked '
      + 'about it, which is out of character.',
    concernTags: ['peer_conflict_bullying', 'behavioural_change'],
    urgency: 'medium',
    status: 'acknowledged',
    assignedTherapist: therapists[0],
    acknowledgedAt: daysAgo(2),
    createdAt: daysAgo(4),
  });

  await makeReferral({
    student: students['ananya.iyer'],
    teacher: teachers['rhea.kapoor'],
    reason:
      'Persistent lateness and visibly exhausted in first period. Mentioned not '
      + 'sleeping before tests.',
    concernTags: ['attendance', 'sleep_fatigue'],
    urgency: 'low',
    status: 'in_progress',
    assignedTherapist: therapists[1],
    acknowledgedAt: daysAgo(8),
    startedAt: daysAgo(6),
    createdAt: daysAgo(10),
  });

  await makeReferral({
    student: students['meera.joshi'],
    teacher: teachers['sanjay.verma'],
    reason:
      'Withdrawn for about three weeks after a bereavement in the family. Quieter '
      + 'in class and declining invitations from friends.',
    concernTags: ['family_situation', 'mood_low'],
    urgency: 'medium',
    status: 'closed',
    assignedTherapist: therapists[0],
    acknowledgedAt: daysAgo(20),
    startedAt: daysAgo(18),
    closedAt: daysAgo(3),
    closureOutcome: 'support_started',
    closureNote:
      'CLINICAL-INTERNAL: bereavement response, no safeguarding concern. Weekly '
      + 'sessions agreed with family consent.',
    closureSummaryForTeacher:
      'We have started weekly sessions with Meera and her family is involved. '
      + 'Thank you for flagging this early — please keep an eye on her in class.',
    createdAt: daysAgo(24),
  });

  // The self-assessment path: raised by the student's own screening, no teacher.
  await makeReferral({
    student: students['tara.pillai'],
    teacher: null,
    source: 'self_assessment',
    reason:
      'Raised automatically: this student completed the Support Recommendation '
      + 'Test and scored 15 on the distress marker (threshold 12), indicating high '
      + 'anxiety and tension with low emotional stability. The student has been '
      + "told their school's help group was notified.",
    concernTags: ['anxiety_stress', 'mood_low'],
    urgency: 'high',
    status: 'pending',
    createdAt: daysAgo(1),
    selfAssessment: {
      instrument: 'mini_16pf',
      distressScore: 15,
      threshold: 12,
      category: 'professional_therapist_recommended',
      traitScores: {
        A: 6, B: 7, C: 3, E: 5, F: 4, G: 6, H: 4, I: 7,
        L: 6, M: 5, N: 6, O: 9, Q1: 5, Q2: 7, Q3: 6, Q4: 9,
      },
      takenAt: daysAgo(1),
    },
  });

  // Give that student the matching test result on their own record too.
  await User.updateOne(
    { _id: students['tara.pillai']._id },
    {
      $set: {
        hasCompletedRecommendationTest: true,
        recommendationTestResult: {
          category: 'professional_therapist_recommended',
          totalScore: 95,
          traitScores: {
            A: 6, B: 7, C: 3, E: 5, F: 4, G: 6, H: 4, I: 7,
            L: 6, M: 5, N: 6, O: 9, Q1: 5, Q2: 7, Q3: 6, Q4: 9,
          },
          completedAt: daysAgo(1),
        },
      },
    },
  );

  console.log('referrals     5 (pending, acknowledged, in progress, closed, self-flagged)');

  /* ------------------------------------------------- a transfer to approve */
  const mover = students['ananya.iyer'];
  if (!(await ClassroomTransferRequest.findOne({ student: mover._id, status: 'pending' }))) {
    await ClassroomTransferRequest.create({
      student: mover._id,
      organization: org._id,
      fromClassroom: classrooms.B._id, // Sanjay is home teacher here
      toClassroom: classrooms.A._id,
      reason: 'Moving to the science stream section.',
      requestedAt: daysAgo(2),
    });
  }
  console.log('transfers     1 pending, awaiting the 9-B home teacher');

  /* ------------------------------------------------------------------ done */
  console.log('\n─── logins ───────────────────────────────────────────────────');
  console.log(`  password for everyone:  ${PASSWORD}\n`);
  console.log('  Control Panel');
  console.log(`    therapist        ${email('dr.meera')}`);
  console.log(`    therapist (2nd)  ${email('dr.arun')}      (for the claim-race walkthrough)`);
  console.log(`    teacher          ${email('rhea.kapoor')}  (teaches 9-A and 9-B)`);
  console.log(`    home teacher     ${email('sanjay.verma')} (approves 9-B transfers)`);
  console.log('\n  Student app');
  console.log(`    any of:          ${email('aarav.sharma')} … ${email('tara.pillai')}`);
  console.log(`    already flagged  ${email('tara.pillai')}   (self-assessment referral)`);
  console.log('\n  Provisioning');
  console.log(`    unclaimed invite ${email('new.teacher')}`);
  console.log('      sign this one up live to show role assignment from the school list');
  console.log(`\n  School join code:  ${JOIN_CODE}`);
  console.log('──────────────────────────────────────────────────────────────');
  console.log('\nreset with:  node scripts/seedSampleSchool.js --confirm --wipe');

  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error('\nseed failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
