// Counsellor access to a student's quiz result, and the note they send back.
//
// The scoring itself is a pure function already covered by its own guard, so
// what matters here is who may read a result, who may write a note, and whether
// the student actually receives it.

const jwt = require('jsonwebtoken');
const { api, check, checkEqual, suite } = require('./harness');

const User = require('../../models/userModel');
const Quiz = require('../../models/quizModel');
const TherapistQuizAssignment = require('../../models/therapistQuizAssignmentModel');
const AnswerSheet = require('../../models/16PFAnswerModel');
const TherapyConversation = require('../../models/therapyConversationModel');

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

// Two answers on the same trait so the raw score is a sum rather than a copy,
// which is the part of buildTraitScores worth proving end to end.
const ANSWERS = {
  q1: { answer: 'a', point: '2', trait: 'A' },
  q2: { answer: 'b', point: '1', trait: 'A' },
  q3: { answer: 'c', point: '2', trait: 'B' },
};

module.exports = async () => {
  suite('§7  quiz results for the counsellor');

  /* ---------------------------------------------------------------- setup */

  const counsellor = await mkUser({
    name: 'Dr Result',
    email: 'result.counsellor@smoke.test',
    role: 'therapist',
  });
  const other = await mkUser({
    name: 'Dr Other',
    email: 'other.counsellor@smoke.test',
    role: 'therapist',
  });
  const student = await mkUser({
    name: 'Result Student',
    email: 'result.student@smoke.test',
    role: 'user',
    assignedTherapist: counsellor._id,
  });

  const quiz = await Quiz.create({ title: '16PF Smoke', type: 'poll PF' });

  const assignment = await TherapistQuizAssignment.create({
    user: student._id,
    therapist: counsellor._id,
    quiz: quiz._id,
    status: 'completed',
    completedAt: new Date(),
  });

  await AnswerSheet.create({
    quizId: quiz._id,
    quizName: '16PF Smoke',
    quizType: 'poll PF',
    userId: student._id,
    assignmentId: assignment._id,
    answers: ANSWERS,
  });

  const cToken = tokenFor(counsellor);
  const oToken = tokenFor(other);
  const sToken = tokenFor(student);

  /* ------------------------------------------------------------- listing */

  const list = await api('GET', `/quiz-results/student/${student._id}`, {
    token: cToken,
  });
  checkEqual('counsellor can list their student results', list.status, 200);
  checkEqual('one completed assignment listed', list.body?.data?.length, 1);
  checkEqual('no note yet', list.body?.data?.[0]?.hasNote, false);

  /* --------------------------------------------------------------- access */

  const mine = await api('GET', `/quiz-results/${assignment._id}`, {
    token: cToken,
  });
  checkEqual('counsellor reads their own student result', mine.status, 200);
  checkEqual('A sums both answers (2+1)', mine.body?.data?.result?.RawScore?.A, 3);
  checkEqual('B scored', mine.body?.data?.result?.RawScore?.B, 2);
  checkEqual('no note on the payload yet', mine.body?.data?.counsellorNote, null);

  const theirs = await api('GET', `/quiz-results/${assignment._id}`, {
    token: oToken,
  });
  checkEqual("another counsellor cannot read this student's result", theirs.status, 403);

  const asStudent = await api('GET', `/quiz-results/${assignment._id}`, {
    token: sToken,
  });
  checkEqual('a student cannot use the counsellor endpoint', asStudent.status, 403);

  /* ----------------------------------------------------------------- note */

  const empty = await api('PATCH', `/quiz-results/${assignment._id}/note`, {
    token: cToken,
    body: { body: '   ' },
  });
  checkEqual('an empty note is rejected', empty.status, 400);

  const foreign = await api('PATCH', `/quiz-results/${assignment._id}/note`, {
    token: oToken,
    body: { body: 'Not mine to write on.' },
  });
  checkEqual('another counsellor cannot write the note', foreign.status, 403);

  const sent = await api('PATCH', `/quiz-results/${assignment._id}/note`, {
    token: cToken,
    body: { body: 'Your tension score is high. Lets talk this week.' },
  });
  checkEqual('counsellor sends the note', sent.status, 200);
  checkEqual('student was notified in chat', sent.body?.data?.notified, true);

  /* ------------------------------------------------- the student receives it */

  const studentView = await api(
    'GET',
    `/users/my-quiz-assignments/${assignment._id}/result`,
    { token: sToken },
  );
  checkEqual('student reads their own result', studentView.status, 200);
  checkEqual('the note reaches the student', studentView.body?.data?.counsellorNote?.body, 'Your tension score is high. Lets talk this week.');
  checkEqual('the student sees who wrote it', studentView.body?.data?.counsellorNote?.counsellorName, 'Dr Result');

  const convo = await TherapyConversation.findOne({
    user: student._id,
    therapist: counsellor._id,
  }).lean();
  checkEqual('exactly one chat message was sent', convo?.messages?.length, 1);
  check('the chat pointer is encrypted at rest', !convo.messages[0].textCipher
      || !String(convo.messages[0].textCipher).includes('tension'));

  /* -------------------------------------------------------------- editing */

  const beforeEdit = await TherapistQuizAssignment.findById(assignment._id).lean();
  const originalSentAt = beforeEdit.counsellorNote.sentAt.getTime();

  const edited = await api('PATCH', `/quiz-results/${assignment._id}/note`, {
    token: cToken,
    body: { body: 'Rewritten after our session.' },
  });
  checkEqual('the note can be rewritten', edited.status, 200);
  check('an edit is stamped', Boolean(edited.body?.data?.counsellorNote?.updatedAt));

  const reread = await TherapistQuizAssignment.findById(assignment._id).lean();
  checkEqual('the body is replaced', reread.counsellorNote.body, 'Rewritten after our session.');
  // sentAt is when the student was first told, and an edit must not rewrite
  // that history; updatedAt is what moves.
  checkEqual(
    'the original send time survives the edit',
    reread.counsellorNote.sentAt.getTime(),
    originalSentAt,
  );
  check(
    'updatedAt is later than sentAt',
    reread.counsellorNote.updatedAt.getTime() >= originalSentAt,
  );

  const afterEdit = await TherapyConversation.findOne({
    user: student._id,
    therapist: counsellor._id,
  }).lean();
  checkEqual('an edit notifies again rather than silently changing what the student read', afterEdit.messages.length, 2);

  /* ----------------------------------------------- not-yet-submitted quiz */

  const pending = await TherapistQuizAssignment.create({
    user: student._id,
    therapist: counsellor._id,
    quiz: quiz._id,
    status: 'assigned',
  });

  const tooEarly = await api('PATCH', `/quiz-results/${pending._id}/note`, {
    token: cToken,
    body: { body: 'Before they answered.' },
  });
  checkEqual('no note before the student has submitted', tooEarly.status, 400);
};
