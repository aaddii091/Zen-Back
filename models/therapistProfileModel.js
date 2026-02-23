const mongoose = require('mongoose');
const validator = require('validator');

const therapistProfileSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User is required'],
      unique: true,
      index: true,
    },
    displayName: {
      type: String,
      trim: true,
    },
    title: {
      type: String,
      trim: true,
      default: 'Therapist',
    },
    specializations: [
      {
        type: String,
        trim: true,
      },
    ],
    yearsOfExperience: {
      type: Number,
      min: 0,
      max: 70,
    },
    languages: [
      {
        type: String,
        trim: true,
      },
    ],
    sessionModes: [
      {
        type: String,
        enum: ['video', 'audio', 'chat', 'in_person'],
      },
    ],
    timezone: {
      type: String,
      trim: true,
    },
    bio: {
      type: String,
      trim: true,
      maxlength: 800,
    },
    calendlyUrl: {
      type: String,
      trim: true,
      validate: {
        validator: function (value) {
          if (!value) return true;
          return validator.isURL(value, { require_protocol: true });
        },
        message: 'Please provide a valid Calendly URL',
      },
    },
    calendlyConnected: {
      type: Boolean,
      default: false,
    },
    calendlyUserUri: {
      type: String,
      trim: true,
    },
    calendlyOrganizationUri: {
      type: String,
      trim: true,
    },
    calendlyConnectedAt: {
      type: Date,
    },
    calendlyAccessToken: {
      type: String,
      trim: true,
    },
    calendlyRefreshToken: {
      type: String,
      trim: true,
    },
    calendlyTokenExpiresAt: {
      type: Date,
    },
    availabilityStatus: {
      type: String,
      enum: ['available', 'busy', 'offline'],
      default: 'available',
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model('TherapistProfile', therapistProfileSchema);
