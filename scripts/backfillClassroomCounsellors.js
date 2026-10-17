// Backfill User.assignedTherapist from Classroom.assignedCounsellor.
//
// Schools assign counsellors per classroom now (Classroom.assignedCounsellor).
// Students who joined before that existed either chose their own counsellor or
// have none at all. This script adopts the unassigned ones.
//
//   node scripts/backfillClassroomCounsellors.js            # report only
//   node scripts/backfillClassroomCounsellors.js --apply    # write
//
// It deliberately does NOT re-point a student who already has a counsellor, even
// when that counsellor differs from their classroom's. Breaking a live
// therapeutic relationship mid-term is worse than an inconsistent mapping — those
// students are printed as a reconciliation list for the school to decide on.

const path = require('path');
const mongoose = require('mongoose');

require('dotenv').config({ path: path.join(__dirname, '..', 'config.env') });

const User = require('../models/userModel');
const Classroom = require('../models/classroomModel');

const APPLY = process.argv.includes('--apply');

const run = async () => {
  if (!process.env.DATABASE) throw new Error('DATABASE is not set.');
  await mongoose.connect(process.env.DATABASE, { serverSelectionTimeoutMS: 8000 });

  const classrooms = await Classroom.find({ assignedCounsellor: { $ne: null } })
    .select('_id name grade section organization assignedCounsellor')
    .lean();

  console.log(
    `\n${classrooms.length} classroom(s) have a counsellor assigned.${
      APPLY ? '' : '  (dry run — pass --apply to write)'
    }\n`,
  );

  let assigned = 0;
  const conflicts = [];

  for (const classroom of classrooms) {
    const label =
      [classroom.grade, classroom.section].filter(Boolean).join('-') ||
      classroom.name;

    const unassigned = await User.countDocuments({
      classroom: classroom._id,
      role: 'user',
      $or: [{ assignedTherapist: null }, { assignedTherapist: { $exists: false } }],
    });

    const mismatched = await User.find({
      classroom: classroom._id,
      role: 'user',
      assignedTherapist: { $ne: null, $exists: true },
      $expr: { $ne: ['$assignedTherapist', classroom.assignedCounsellor] },
    })
      .select('_id name email assignedTherapist')
      .lean();

    if (APPLY && unassigned) {
      const { modifiedCount } = await User.updateMany(
        {
          classroom: classroom._id,
          role: 'user',
          $or: [
            { assignedTherapist: null },
            { assignedTherapist: { $exists: false } },
          ],
        },
        { $set: { assignedTherapist: classroom.assignedCounsellor } },
      );
      assigned += modifiedCount || 0;
    } else {
      assigned += unassigned;
    }

    console.log(
      `  ${label.padEnd(16)} ${String(unassigned).padStart(4)} adopted   ${String(
        mismatched.length,
      ).padStart(4)} kept on a different counsellor`,
    );

    mismatched.forEach((student) =>
      conflicts.push({
        classroom: label,
        student: student.name,
        email: student.email,
        keptCounsellor: String(student.assignedTherapist),
        classroomCounsellor: String(classroom.assignedCounsellor),
      }),
    );
  }

  console.log(
    `\n${APPLY ? 'Assigned' : 'Would assign'} ${assigned} student(s) from their classroom.`,
  );

  if (conflicts.length) {
    console.log(
      `\n${conflicts.length} student(s) kept an existing counsellor that differs from their classroom's.`,
    );
    console.log('Hand this list to the school — do not re-point them silently:\n');
    console.table(conflicts);
  }

  await mongoose.connection.close();
};

run().catch(async (err) => {
  console.error('\nBackfill failed:', err.message);
  await mongoose.connection.close().catch(() => {});
  process.exit(1);
});
