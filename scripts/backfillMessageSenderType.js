// Backfill TherapyConversation.messages[].senderType.
//
// Messages written before the after-hours autoresponder existed have no
// senderType. mapConversationPayload defaults a missing value to 'user', which
// would mislabel every message a counsellor ever sent. This sets it from the
// sender's actual role, once.
//
//   node scripts/backfillMessageSenderType.js            # report only
//   node scripts/backfillMessageSenderType.js --apply    # write

const path = require('path');
const mongoose = require('mongoose');

require('dotenv').config({ path: path.join(__dirname, '..', 'config.env') });

const User = require('../models/userModel');
const TherapyConversation = require('../models/therapyConversationModel');

const APPLY = process.argv.includes('--apply');

const run = async () => {
  if (!process.env.DATABASE) throw new Error('DATABASE is not set.');
  await mongoose.connect(process.env.DATABASE, { serverSelectionTimeoutMS: 8000 });

  const conversations = await TherapyConversation.find({})
    .select('user therapist messages')
    .lean();

  let scanned = 0;
  let needing = 0;
  let updatedThreads = 0;

  for (const conversation of conversations) {
    const messages = conversation.messages || [];
    scanned += messages.length;

    const missing = messages.filter((m) => !m.senderType);
    if (!missing.length) continue;
    needing += missing.length;

    if (!APPLY) continue;

    // The two participants are the only possible senders on a pre-existing
    // message; a null sender can only be a system message, which did not exist
    // before this migration, so it cannot occur here.
    const therapistId = String(conversation.therapist || '');
    const updates = messages.map((m) => {
      if (m.senderType) return m.senderType;
      if (!m.sender) return 'system';
      return String(m.sender) === therapistId ? 'therapist' : 'user';
    });

    await TherapyConversation.updateOne({ _id: conversation._id }, {
      $set: Object.fromEntries(
        updates.map((senderType, index) => [
          `messages.${index}.senderType`,
          senderType,
        ]),
      ),
    });
    updatedThreads += 1;
  }

  console.log(
    `\nScanned ${scanned} message(s) across ${conversations.length} thread(s).`,
  );
  console.log(
    `${needing} message(s) ${APPLY ? 'backfilled' : 'need a senderType'}` +
      (APPLY ? ` across ${updatedThreads} thread(s).` : '  (dry run — pass --apply to write)'),
  );

  await mongoose.connection.close();
};

run().catch(async (err) => {
  console.error('\nBackfill failed:', err.message);
  await mongoose.connection.close().catch(() => {});
  process.exit(1);
});
