const mongoose = require('mongoose');

const shortCourseProgressSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User is required'],
      index: true,
    },
    courseId: {
      type: String,
      required: [true, 'Course id is required'],
      index: true,
    },
    status: {
      type: String,
      enum: ['in_progress', 'completed'],
      default: 'in_progress',
    },
    currentSectionId: {
      type: String,
      default: '',
    },
    completedSectionIds: {
      type: [String],
      default: [],
    },
    completedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

shortCourseProgressSchema.index({ user: 1, courseId: 1 }, { unique: true });

module.exports = mongoose.model('ShortCourseProgress', shortCourseProgressSchema);
