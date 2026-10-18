const mongoose = require('mongoose');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const User = require('../models/userModel');
const TherapyConversation = require('../models/therapyConversationModel');
const TherapistProfile = require('../models/therapistProfileModel');
const {
  decryptChatText,
  encryptChatText,
  isChatEncryptionReady,
} = require('../utils/chatCrypto');
const {
  isWithinWorkingHours,
  buildAfterHoursMessage,
} = require('../utils/workingHours');

// A student messaging five times at midnight must not get five identical bot
// replies. One automated reply per thread per window.
const AUTO_REPLY_DEBOUNCE_HOURS = 8;

const asObjectIdOrNull = (value) => {
  if (!value || typeof value !== 'string') return null;
  return mongoose.Types.ObjectId.isValid(value)
    ? new mongoose.Types.ObjectId(value)
    : null;
};

const resolveConversationContext = async (req) => {
  const requester = req.user;
  if (!requester) {
    throw new AppError('You are not logged in. Please log in to get access.', 401);
  }

  if (requester.role === 'user') {
    const userRecord = await User.findById(requester._id)
      .select('assignedTherapist role')
      .lean();

    if (!userRecord || userRecord.role !== 'user') {
      throw new AppError('User not found.', 404);
    }
    if (!userRecord.assignedTherapist) {
      throw new AppError('No therapist assigned to this user.', 400);
    }

    return {
      userId: requester._id,
      therapistId: userRecord.assignedTherapist,
    };
  }

  if (requester.role === 'therapist') {
    const userIdRaw = String(req.query?.userId || req.body?.userId || '').trim();
    if (!userIdRaw) {
      throw new AppError('userId is required for therapist chat access.', 400);
    }

    const userId = asObjectIdOrNull(userIdRaw);
    if (!userId) {
      throw new AppError('Invalid userId.', 400);
    }

    const targetUser = await User.findById(userId)
      .select('role assignedTherapist')
      .lean();

    if (!targetUser || targetUser.role !== 'user') {
      throw new AppError('Target user not found.', 404);
    }
    if (
      !targetUser.assignedTherapist ||
      String(targetUser.assignedTherapist) !== String(requester._id)
    ) {
      throw new AppError('This user is not assigned to this therapist.', 403);
    }

    return {
      userId,
      therapistId: requester._id,
    };
  }

  throw new AppError('Only users and therapists can access therapy chat.', 403);
};

const ensureConversation = async ({ userId, therapistId }) => {
  const conversation = await TherapyConversation.findOneAndUpdate(
    { user: userId, therapist: therapistId },
    {
      $setOnInsert: {
        user: userId,
        therapist: therapistId,
      },
    },
    {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
    },
  );

  return conversation;
};

const mapConversationPayload = (conversation, requesterId) => {
  const user = conversation?.user || {};
  const therapist = conversation?.therapist || {};
  const messages = Array.isArray(conversation?.messages)
    ? conversation.messages.map((message) => ({
        text: (() => {
          try {
            return decryptChatText({
              textCipher: message?.textCipher,
              textIv: message?.textIv,
              textAuthTag: message?.textAuthTag,
            });
          } catch {
            return '[Unable to decrypt message]';
          }
        })(),
        id: message?._id,
        sentAt: message?.sentAt || null,
        senderType: message?.senderType || 'user',
        sender: {
          id: message?.sender?._id || message?.sender || null,
          name: message?.sender?.name || '',
          role: message?.sender?.role || '',
          isMe:
            Boolean(message?.sender) &&
            String(message?.sender?._id || message?.sender || '') ===
              String(requesterId),
        },
      }))
    : [];

  return {
    id: conversation?._id,
    participants: {
      user: {
        id: user?._id || null,
        name: user?.name || '',
        email: user?.email || '',
      },
      therapist: {
        id: therapist?._id || null,
        name: therapist?.name || '',
        email: therapist?.email || '',
      },
    },
    messages,
    updatedAt: conversation?.updatedAt || null,
  };
};

// A student messaging outside their counsellor's working hours gets an immediate
// automated reply naming when the counsellor is back, plus the 24/7 crisis lines.
//
// Returns the message to append, or null. Every guard here is a reason NOT to
// send: silence is the safe default, an unwanted bot reply to a distressed child
// is not.
const buildAutoReplyIfAfterHours = async ({ context, requester, conversation }) => {
  // Only ever in response to the student. A counsellor messaging at 11pm is
  // working late, not triggering their own autoresponder.
  if (requester.role !== 'user') return null;

  const profile = await TherapistProfile.findOne({ user: context.therapistId })
    .select('workingHours timezone')
    .lean();

  if (!profile?.workingHours?.enabled) return null;

  if (
    isWithinWorkingHours(profile.workingHours, {
      fallbackTimezone: profile.timezone,
    })
  ) {
    return null;
  }

  const cutoff = Date.now() - AUTO_REPLY_DEBOUNCE_HOURS * 60 * 60 * 1000;
  const recentlyAutoReplied = (conversation.messages || []).some(
    (message) =>
      message.senderType === 'system' &&
      message.sentAt &&
      new Date(message.sentAt).getTime() > cutoff,
  );
  if (recentlyAutoReplied) return null;

  // Encrypted with the same key as every other message — an automated reply is
  // still part of a clinical thread and gets no plaintext exception.
  return {
    sender: null,
    senderType: 'system',
    ...encryptChatText(
      buildAfterHoursMessage(profile.workingHours, {
        fallbackTimezone: profile.timezone,
      }),
    ),
    sentAt: new Date(),
  };
};

exports.getThread = catchAsync(async (req, res) => {
  if (!isChatEncryptionReady()) {
    throw new AppError(
      'Secure chat encryption is not configured. Set CHAT_ENCRYPTION_KEY in backend env.',
      500,
    );
  }

  const context = await resolveConversationContext(req);
  await ensureConversation(context);

  const conversation = await TherapyConversation.findOne({
    user: context.userId,
    therapist: context.therapistId,
  })
    .populate('user', 'name email')
    .populate('therapist', 'name email')
    .populate('messages.sender', 'name role')
    .lean();

  res.status(200).json({
    status: 'success',
    data: mapConversationPayload(conversation, req.user._id),
  });
});

exports.sendMessage = catchAsync(async (req, res, next) => {
  if (!isChatEncryptionReady()) {
    throw new AppError(
      'Secure chat encryption is not configured. Set CHAT_ENCRYPTION_KEY in backend env.',
      500,
    );
  }

  const context = await resolveConversationContext(req);
  const text = String(req.body?.text || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .trim();

  if (!text) {
    return next(new AppError('text is required', 400));
  }
  if (text.length > 2000) {
    return next(new AppError('Message is too long (max 2000 chars).', 400));
  }

  const conversation = await ensureConversation(context);
  const encrypted = encryptChatText(text);
  conversation.messages.push({
    sender: req.user._id,
    senderType: req.user.role === 'therapist' ? 'therapist' : 'user',
    ...encrypted,
    sentAt: new Date(),
  });

  const autoReply = await buildAutoReplyIfAfterHours({ context, requester: req.user, conversation });
  if (autoReply) {
    conversation.messages.push(autoReply);
  }

  // Keep latest 500 messages per thread to bound document size.
  if (conversation.messages.length > 500) {
    conversation.messages = conversation.messages.slice(-500);
  }

  await conversation.save();

  const refreshed = await TherapyConversation.findById(conversation._id)
    .populate('user', 'name email')
    .populate('therapist', 'name email')
    .populate('messages.sender', 'name role')
    .lean();

  const mapped = mapConversationPayload(refreshed, req.user._id);

  // The sender's own message is what the client echoes into the thread; the
  // auto-reply is handed back separately so the UI can style it as automated
  // rather than mistaking it for the last thing the sender said.
  const ownMessages = mapped.messages.filter((m) => m.senderType !== 'system');
  const lastMessage = ownMessages[ownMessages.length - 1] || null;
  const systemReply = autoReply
    ? mapped.messages[mapped.messages.length - 1] || null
    : null;

  res.status(201).json({
    status: 'success',
    data: {
      conversationId: mapped.id,
      message: lastMessage,
      autoReply: systemReply,
      updatedAt: mapped.updatedAt,
    },
  });
});

// GET /api/v1/therapy-chat/previews
//
// One request for the whole message list, replacing one getThread per client.
// The panel was firing N requests just to render N one-line previews, each of
// which decrypted an entire thread and, because getThread upserts, created an
// empty conversation document for every client it touched.
//
// Only the last message of each thread is decrypted, and nothing is created.
exports.getThreadPreviews = catchAsync(async (req, res, next) => {
  if (req.user.role !== 'therapist') {
    return next(new AppError('Only therapists can list message previews.', 403));
  }
  if (!isChatEncryptionReady()) {
    throw new AppError(
      'Secure chat encryption is not configured. Set CHAT_ENCRYPTION_KEY in backend env.',
      500,
    );
  }

  // Slice to the last message server-side so a 500-message thread does not
  // travel over the wire to produce a 60-character preview.
  const conversations = await TherapyConversation.aggregate([
    { $match: { therapist: req.user._id } },
    {
      $project: {
        user: 1,
        updatedAt: 1,
        count: { $size: { $ifNull: ['$messages', []] } },
        last: { $slice: [{ $ifNull: ['$messages', []] }, -1] },
      },
    },
  ]);

  const data = conversations.map((c) => {
    const last = (c.last || [])[0];
    let text = '';
    if (last) {
      try {
        text = decryptChatText(last);
      } catch {
        text = '[Unable to decrypt message]';
      }
    }
    return {
      userId: c.user,
      messageCount: c.count || 0,
      lastMessage: last
        ? {
            text: String(text).slice(0, 120),
            sentAt: last.sentAt || null,
            senderType: last.senderType || 'user',
          }
        : null,
      updatedAt: c.updatedAt || null,
    };
  });

  res.status(200).json({ status: 'success', results: data.length, data });
});
