const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const ShortCourseProgress = require('../models/shortCourseProgressModel');

const normalizeCourseId = (value) => String(value || '').trim();

const normalizeSectionList = (value) => {
  if (!value) return [];
  const rawList = Array.isArray(value) ? value : [value];
  return rawList
    .map((item) => String(item || '').trim())
    .filter((item) => item.length > 0);
};

exports.getMyShortCourseProgress = catchAsync(async (req, res) => {
  const progress = await ShortCourseProgress.find({ user: req.user._id });

  res.status(200).json({
    status: 'success',
    data: progress,
  });
});

exports.upsertMyShortCourseProgress = catchAsync(async (req, res, next) => {
  const courseId = normalizeCourseId(req.body?.courseId);
  if (!courseId) {
    return next(new AppError('Course id is required.', 400));
  }

  const status = req.body?.status === 'completed' ? 'completed' : 'in_progress';
  const completedSectionIds = normalizeSectionList(req.body?.completedSectionIds);
  const currentSectionId = String(req.body?.currentSectionId || '').trim();
  const completedAt = status === 'completed' ? req.body?.completedAt || new Date() : null;

  const progress = await ShortCourseProgress.findOneAndUpdate(
    { user: req.user._id, courseId },
    {
      $set: {
        status,
        currentSectionId,
        completedSectionIds,
        completedAt,
      },
      $setOnInsert: {
        user: req.user._id,
        courseId,
      },
    },
    {
      new: true,
      upsert: true,
      runValidators: true,
      setDefaultsOnInsert: true,
    }
  );

  res.status(200).json({
    status: 'success',
    data: progress,
  });
});
