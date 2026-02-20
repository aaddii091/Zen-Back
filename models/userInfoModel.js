const mongoose = require('mongoose');

const userInfoSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User is required'],
      unique: true,
      index: true,
    },
    primaryConcern: {
      type: String,
      enum: [
        'stress',
        'anxiety',
        'work_burnout',
        'relationships',
        'sleep',
        'other',
      ],
    },
    therapistGenderPref: {
      type: String,
      enum: ['male', 'female', 'no_preference'],
    },
    languagePref: {
      type: String,
      trim: true,
    },
    sessionMode: {
      type: String,
      enum: ['zoom_video', 'prefer_something_else'],
    },
    availabilityPrefs: [
      {
        type: String,
        enum: [
          'weekdays',
          'weekends',
          'mornings',
          'afternoons',
          'evenings',
          'flexible',
        ],
      },
    ],
    timezone: {
      type: String,
      trim: true,
    },
    reminderChannel: {
      type: String,
      enum: ['email', 'sms_whatsapp', 'no_reminders'],
    },
    trustedContact: {
      enabled: {
        type: Boolean,
        default: false,
      },
      name: {
        type: String,
        trim: true,
      },
      email: {
        type: String,
        trim: true,
      },
      relationship: {
        type: String,
        trim: true,
      },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('UserInfo', userInfoSchema);
