const mongoose = require('mongoose');

const therapyMessageSchema = new mongoose.Schema(
  {
    // Null for senderType 'system': an automated after-hours reply is not sent by
    // a person, and attributing it to the counsellor would read to a student in
    // distress as though the counsellor had personally answered at midnight.
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    senderType: {
      type: String,
      enum: ['user', 'therapist', 'system'],
      default: 'user',
      required: true,
    },
    textCipher: {
      type: String,
      required: [true, 'Encrypted message text is required'],
    },
    textIv: {
      type: String,
      required: [true, 'Message IV is required'],
    },
    textAuthTag: {
      type: String,
      required: [true, 'Message auth tag is required'],
    },
    keyVersion: {
      type: Number,
      default: 1,
      min: 1,
    },
    sentAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: true },
);

const therapyConversationSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    therapist: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    messages: {
      type: [therapyMessageSchema],
      default: [],
    },
  },
  { timestamps: true },
);

therapyConversationSchema.index({ user: 1, therapist: 1 }, { unique: true });

module.exports = mongoose.model('TherapyConversation', therapyConversationSchema);
