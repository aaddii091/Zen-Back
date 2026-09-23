const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const StudyCounseling = require('../models/studyCounselingModel');
const User = require('../models/userModel');

exports.startOrGetSession = catchAsync(async (req, res) => {
  const session = await StudyCounseling.findOneAndUpdate(
    { user: req.user._id },
    { $setOnInsert: { user: req.user._id } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  res.status(200).json({
    status: 'success',
    data: session,
  });
});

exports.saveDetails = catchAsync(async (req, res, next) => {
  const { focusAreas, academicConcerns, studyHabits } = req.body;

  const session = await StudyCounseling.findOneAndUpdate(
    { user: req.user._id },
    {
      focusAreas,
      academicConcerns,
      studyHabits,
      status: 'requested',
    },
    { new: true, upsert: true },
  );

  if (!session) return next(new AppError('Session not found', 404));

  res.status(200).json({
    status: 'success',
    data: session,
  });
});

exports.getMySession = catchAsync(async (req, res, next) => {
  const session = await StudyCounseling.findOne({ user: req.user._id });
  if (!session) return next(new AppError('No study counseling session found for this user', 404));

  res.status(200).json({
    status: 'success',
    data: session,
  });
});

exports.getMyCounselor = catchAsync(async (req, res) => {
  const user = await User.findById(req.user._id).select('assignedStudyCounselor');
  if (!user?.assignedStudyCounselor) {
    return res.status(200).json({ status: 'success', data: null });
  }

  const TherapistProfile = require('../models/therapistProfileModel');
  const profile = await TherapistProfile.findOne({ user: user.assignedStudyCounselor }).lean();
  if (!profile) return res.status(200).json({ status: 'success', data: null });

  const counselorUser = await User.findById(user.assignedStudyCounselor).select('name email').lean();

  const photoUrl = (() => {
    const d = profile?.photo?.data;
    const ct = profile?.photo?.contentType;
    if (!d || !ct) return '';
    return `data:${ct};base64,${Buffer.from(d).toString('base64')}`;
  })();

  res.status(200).json({
    status: 'success',
    data: {
      counselorUserId: String(user.assignedStudyCounselor),
      displayName: profile.displayName || counselorUser?.name || 'Study Counselor',
      title: profile.title || 'Study Counselor',
      bio: profile.bio || '',
      specializations: profile.specializations || [],
      languages: profile.languages || [],
      sessionModes: profile.sessionModes || [],
      calendlyUrl: profile.calendlyUrl || '',
      availabilityStatus: profile.availabilityStatus || '',
      photoUrl,
    },
  });
});

exports.assignCounselor = catchAsync(async (req, res, next) => {
  const { userId } = req.params;
  const counselorId = req.user._id;

  const targetUser = await User.findById(userId);
  if (!targetUser) return next(new AppError('User not found', 404));

  targetUser.assignedStudyCounselor = counselorId;
  await targetUser.save({ validateBeforeSave: false });

  res.status(200).json({
    status: 'success',
    message: 'Study counselor assigned successfully',
  });
});

exports.assignTherapistToStudent = catchAsync(async (req, res, next) => {
  const { userId } = req.params;
  const { therapistId } = req.body;
  const counselorId = req.user._id;

  if (!therapistId) return next(new AppError('therapistId is required', 400));

  const targetUser = await User.findById(userId);
  if (!targetUser) return next(new AppError('User not found', 404));

  targetUser.assignedTherapist = therapistId;
  await targetUser.save({ validateBeforeSave: false });

  res.status(200).json({
    status: 'success',
    message: 'Clinical therapist assigned to student successfully',
  });
});

exports.getAvailableTherapists = catchAsync(async (req, res) => {
  const TherapistProfile = require('../models/therapistProfileModel');

  const therapistUsers = await User.find({
    $or: [
      { role: 'therapist' },
      { roles: 'therapist' },
    ],
  }).select('name email').lean();

  const therapistIds = therapistUsers.map(u => u._id);
  const profiles = await TherapistProfile.find({ user: { $in: therapistIds } }).lean();
  const profileMap = {};
  profiles.forEach(p => { profileMap[String(p.user)] = p; });

  const result = therapistUsers.map(u => {
    const profile = profileMap[String(u._id)] || {};
    return {
      therapistUserId: String(u._id),
      displayName: profile.displayName || u.name || 'Therapist',
      title: profile.title || 'Clinical Therapist',
      specializations: profile.specializations || [],
      languages: profile.languages || [],
    };
  });

  res.status(200).json({
    status: 'success',
    data: result,
  });
});

exports.getAllSessions = catchAsync(async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const skip = (page - 1) * limit;

  const sessions = await StudyCounseling.find()
    .populate('user', 'name email')
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit);

  const total = await StudyCounseling.countDocuments();

  res.status(200).json({
    status: 'success',
    total,
    page,
    data: sessions,
  });
});
