const mongoose = require('mongoose');

const appointmentSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true,
    },
    therapist: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true,
    },
    userName: {
      type: String,
      trim: true,
    },
    userEmail: {
      type: String,
      trim: true,
      lowercase: true,
    },
    therapistName: {
      type: String,
      trim: true,
    },
    therapistEmail: {
      type: String,
      trim: true,
      lowercase: true,
    },
    scheduledAt: {
      type: Date,
      index: true,
    },
    endsAt: {
      type: Date,
    },
    timezone: {
      type: String,
      trim: true,
    },
    sessionType: {
      type: String,
      trim: true,
    },
    status: {
      type: String,
      enum: ['scheduled', 'canceled', 'rescheduled'],
      default: 'scheduled',
      index: true,
    },
    calendlyEventUri: {
      type: String,
      trim: true,
      unique: true,
      sparse: true,
      index: true,
    },
    calendlyInviteeUri: {
      type: String,
      trim: true,
      index: true,
    },
    tracking: {
      type: mongoose.Schema.Types.Mixed,
    },
    rawPayload: {
      type: mongoose.Schema.Types.Mixed,
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model('Appointment', appointmentSchema);
