const mongoose = require('mongoose');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const User = require('../models/userModel');
const TherapyConversation = require('../models/therapyConversationModel');
const {
  decryptChatText,
  encryptChatText,
  isChatEncryptionReady,
} = require('../utils/chatCrypto');

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
        sender: {
          id: message?.sender?._id || message?.sender || null,
          name: message?.sender?.name || '',
          role: message?.sender?.role || '',
          isMe: String(message?.sender?._id || message?.sender || '') === String(requesterId),
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
    ...encrypted,
    sentAt: new Date(),
  });

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
  const lastMessage = mapped.messages[mapped.messages.length - 1] || null;

  res.status(201).json({
    status: 'success',
    data: {
      conversationId: mapped.id,
      message: lastMessage,
      updatedAt: mapped.updatedAt,
    },
  });
});
