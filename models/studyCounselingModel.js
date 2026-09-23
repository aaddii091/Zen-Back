const mongoose = require('mongoose');

const studyCounselingSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
    status: {
      type: String,
      enum: ['requested', 'scheduled', 'in_progress', 'completed', 'cancelled'],
      default: 'requested',
    },
    focusAreas: [String],
    academicConcerns: String,
    studyHabits: String,
    recommendations: [String],
    sessionBooked: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true },
);

const StudyCounseling = mongoose.model('StudyCounseling', studyCounselingSchema);

module.exports = StudyCounseling;
