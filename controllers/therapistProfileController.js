const catchAsync = require('../utils/catchAsync');
const TherapistProfile = require('../models/therapistProfileModel');

const normalizeStringList = (value) => {
  if (value === undefined) return value;
  const values = Array.isArray(value) ? value : [value];
  return values
    .map((item) => String(item).trim())
    .filter((item) => item.length > 0);
};

const normalizeSessionModes = (value) => {
  if (value === undefined) return value;
  const values = Array.isArray(value) ? value : [value];

  const map = {
    zoom_video: 'video',
    video_call: 'video',
    video: 'video',
    audio_call: 'audio',
    audio: 'audio',
    chat: 'chat',
    in_person: 'in_person',
    inperson: 'in_person',
  };

  return values
    .map((item) => String(item).toLowerCase().trim().replace(/\s+/g, '_'))
    .map((item) => map[item] || item)
    .filter((item) =>
      ['video', 'audio', 'chat', 'in_person'].includes(item),
    );
};

const buildUpdatePayload = (body = {}) => {
  const payload = {};

  if (body.displayName !== undefined) payload.displayName = body.displayName;
  if (body.title !== undefined) payload.title = body.title;
  if (body.specializations !== undefined) {
    payload.specializations = normalizeStringList(body.specializations);
  }
  if (body.yearsOfExperience !== undefined) {
    payload.yearsOfExperience = body.yearsOfExperience;
  }
  if (body.languages !== undefined) {
    payload.languages = normalizeStringList(body.languages);
  }
  if (body.sessionModes !== undefined) {
    payload.sessionModes = normalizeSessionModes(body.sessionModes);
  }
  if (body.timezone !== undefined) payload.timezone = body.timezone;
  if (body.bio !== undefined) payload.bio = body.bio;
  if (body.calendlyUrl !== undefined) payload.calendlyUrl = body.calendlyUrl;
  if (body.availabilityStatus !== undefined) {
    payload.availabilityStatus = body.availabilityStatus;
  }

  return payload;
};

exports.getMyProfile = catchAsync(async (req, res) => {
  const therapistProfile = await TherapistProfile.findOne({ user: req.user._id });

  res.status(200).json({
    status: 'success',
    data: therapistProfile,
  });
});

exports.insertMyProfile = catchAsync(async (req, res) => {
  const updatePayload = buildUpdatePayload(req.body);

  const therapistProfile = await TherapistProfile.findOneAndUpdate(
    { user: req.user._id },
    {
      $set: updatePayload,
      $setOnInsert: {
        user: req.user._id,
        displayName: req.user.name,
      },
    },
    {
      new: true,
      upsert: true,
      runValidators: true,
      setDefaultsOnInsert: true,
    },
  );

  res.status(200).json({
    status: 'success',
    data: therapistProfile,
  });
});
