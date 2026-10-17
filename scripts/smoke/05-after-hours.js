// §5 — a student messaging outside working hours gets an immediate automated
// reply with crisis resources.

const jwt = require('jsonwebtoken');
const { api, check, checkEqual, suite } = require('./harness');

const User = require('../../models/userModel');
const TherapistProfile = require('../../models/therapistProfileModel');
const TherapyConversation = require('../../models/therapyConversationModel');
const {
  isWithinWorkingHours,
  describeNextWindow,
} = require('../../utils/workingHours');

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

const TZ = 'Asia/Kolkata';
const allDay = (weekday) => ({ weekday, startMinute: 0, endMinute: 1439 });
const nowWeekdayIn = (tz) =>
  ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(
      new Date(),
    ),
  );

module.exports = async () => {
  suite('§5  after-hours auto-reply');

  /* ------------------------------------------------- pure logic, no network */

  const today = nowWeekdayIn(TZ);

  checkEqual(
    'a disabled configuration never counts as after-hours',
    isWithinWorkingHours({ enabled: false, days: [] }),
    true,
  );
  checkEqual(
    'an enabled configuration with no windows is treated as available',
    isWithinWorkingHours({ enabled: true, timezone: TZ, days: [] }),
    true,
  );
  checkEqual(
    'open all day today reads as within hours',
    isWithinWorkingHours({ enabled: true, timezone: TZ, days: [allDay(today)] }),
    true,
  );
  checkEqual(
    'open only on other days reads as outside hours',
    isWithinWorkingHours({
      enabled: true,
      timezone: TZ,
      days: [allDay((today + 1) % 7), allDay((today + 2) % 7)],
    }),
    false,
  );
  checkEqual(
    'a malformed window (end before start) is ignored',
    isWithinWorkingHours({
      enabled: true,
      timezone: TZ,
      days: [{ weekday: today, startMinute: 600, endMinute: 100 }],
    }),
    true, // no usable windows -> treated as available
  );
  check(
    'an invalid timezone does not throw',
    isWithinWorkingHours({
      enabled: true,
      timezone: 'Not/AZone',
      days: [allDay(today)],
    }) === true,
  );
  check(
    'the next window is described in words',
    /tomorrow at|at \d|today at/.test(
      describeNextWindow({
        enabled: true,
        timezone: TZ,
        days: [{ weekday: (today + 1) % 7, startMinute: 540, endMinute: 1020 }],
      }),
    ),
    `got "${describeNextWindow({
      enabled: true,
      timezone: TZ,
      days: [{ weekday: (today + 1) % 7, startMinute: 540, endMinute: 1020 }],
    })}"`,
  );

  /* ---------------------------------------------------------------- setup */

  const counsellor = await mkUser({
    name: 'Hours Counsellor',
    email: 'hours.counsellor@smoke.test',
    role: 'therapist',
  });
  const student = await mkUser({
    name: 'Hours Student',
    email: 'hours.student@smoke.test',
    role: 'user',
    assignedTherapist: counsellor._id,
  });

  const studentToken = tokenFor(student);
  const counsellorToken = tokenFor(counsellor);

  await TherapistProfile.create({
    user: counsellor._id,
    displayName: 'Hours Counsellor',
    timezone: TZ,
    workingHours: { enabled: false, timezone: TZ, days: [] },
  });

  /* ---------------------------------------- disabled hours -> no auto-reply */

  const duringOff = await api('POST', '/therapy-chat/message', {
    token: studentToken,
    body: { text: 'Hello, are you there?' },
  });
  checkEqual('student can send a message', duringOff.status, 201);
  check(
    'no auto-reply while working hours are disabled',
    !duringOff.body?.data?.autoReply,
    `got ${JSON.stringify(duringOff.body?.data?.autoReply)}`,
  );

  /* ----------------------------------------- outside hours -> one auto-reply */

  await TherapistProfile.updateOne(
    { user: counsellor._id },
    {
      $set: {
        workingHours: {
          enabled: true,
          timezone: TZ,
          // Open only on the two days that are not today.
          days: [allDay((today + 1) % 7), allDay((today + 2) % 7)],
        },
      },
    },
  );

  const afterHours = await api('POST', '/therapy-chat/message', {
    token: studentToken,
    body: { text: 'I am having a really hard night.' },
  });
  checkEqual('message still sends after hours', afterHours.status, 201);

  const reply = afterHours.body?.data?.autoReply;
  check('an auto-reply is returned', Boolean(reply), 'no autoReply in payload');
  checkEqual('the auto-reply is typed as system', reply?.senderType, 'system');
  check(
    'the auto-reply carries crisis numbers',
    String(reply?.text || '').includes('14416') &&
      String(reply?.text || '').includes('1098'),
    `text was: ${String(reply?.text || '').slice(0, 160)}`,
  );
  check(
    'the auto-reply says it is automated',
    String(reply?.text || '').includes('automated'),
  );
  check(
    'the student’s own message is still returned separately',
    afterHours.body?.data?.message?.senderType === 'user',
    `got ${afterHours.body?.data?.message?.senderType}`,
  );

  /* -------------------------------------------------- stored and encrypted */

  const conversation = await TherapyConversation.findOne({
    user: student._id,
    therapist: counsellor._id,
  }).lean();

  const systemMessages = conversation.messages.filter(
    (m) => m.senderType === 'system',
  );
  checkEqual('exactly one system message is stored', systemMessages.length, 1);
  checkEqual('a system message has no sender', systemMessages[0].sender, null);
  check(
    'the auto-reply is encrypted at rest like every other message',
    Boolean(systemMessages[0].textCipher) &&
      Boolean(systemMessages[0].textIv) &&
      Boolean(systemMessages[0].textAuthTag) &&
      !JSON.stringify(systemMessages[0]).includes('automated'),
  );
  checkEqual(
    'the student’s message is typed as user',
    conversation.messages.filter((m) => m.senderType === 'user').length,
    2,
  );

  /* --------------------------------------------------------- the debounce */

  const second = await api('POST', '/therapy-chat/message', {
    token: studentToken,
    body: { text: 'Are you awake?' },
  });
  check(
    'a second message in the window gets no duplicate auto-reply',
    !second.body?.data?.autoReply,
    `got ${JSON.stringify(second.body?.data?.autoReply)}`,
  );

  const afterSecond = await TherapyConversation.findOne({
    user: student._id,
    therapist: counsellor._id,
  }).lean();
  checkEqual(
    'still exactly one system message after a second send',
    afterSecond.messages.filter((m) => m.senderType === 'system').length,
    1,
  );

  /* ------------------------------- a counsellor does not trigger their own bot */

  const byCounsellor = await api('POST', '/therapy-chat/message', {
    token: counsellorToken,
    body: { userId: String(student._id), text: 'I saw your message, I am here.' },
  });
  checkEqual('counsellor can reply after hours', byCounsellor.status, 201);
  check(
    'a counsellor working late does not trigger the autoresponder',
    !byCounsellor.body?.data?.autoReply,
  );
  checkEqual(
    'the counsellor message is typed as therapist',
    byCounsellor.body?.data?.message?.senderType,
    'therapist',
  );

  /* ---------------------------------------------- the thread still decrypts */

  const thread = await api('GET', '/therapy-chat/thread', { token: studentToken });
  checkEqual('thread loads', thread.status, 200);
  check(
    'no message fails to decrypt',
    (thread.body?.data?.messages || []).every(
      (m) => m.text !== '[Unable to decrypt message]',
    ),
  );
  check(
    'the system message is flagged for the student UI',
    (thread.body?.data?.messages || []).some((m) => m.senderType === 'system'),
  );
  check(
    'a system message is never attributed to the reader',
    (thread.body?.data?.messages || [])
      .filter((m) => m.senderType === 'system')
      .every((m) => m.sender.isMe === false),
  );

  /* ------------------------------------------ within hours -> no auto-reply */

  await TherapistProfile.updateOne(
    { user: counsellor._id },
    { $set: { 'workingHours.days': [allDay(today)] } },
  );
  await TherapyConversation.updateOne(
    { user: student._id, therapist: counsellor._id },
    { $pull: { messages: { senderType: 'system' } } }, // clear the debounce
  );

  const inHours = await api('POST', '/therapy-chat/message', {
    token: studentToken,
    body: { text: 'Good morning!' },
  });
  check(
    'no auto-reply during working hours',
    !inHours.body?.data?.autoReply,
    `got ${JSON.stringify(inHours.body?.data?.autoReply)}`,
  );

};
