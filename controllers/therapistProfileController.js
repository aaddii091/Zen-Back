const catchAsync = require('../utils/catchAsync');
const TherapistProfile = require('../models/therapistProfileModel');
const multer = require('multer');
const AppError = require('../utils/appError');

const photoStorage = multer.memoryStorage();
const photoFilter = (req, file, cb) => {
  if (file?.mimetype?.startsWith('image/')) {
    cb(null, true);
  } else {
    cb(new AppError('Only image files are allowed.', 400), false);
  }
};

exports.uploadTherapistPhoto = multer({
  storage: photoStorage,
  fileFilter: photoFilter,
}).single('photo');

const buildPhotoUrl = (profile) => {
  const data = profile?.photo?.data;
  const contentType = profile?.photo?.contentType;
  if (!data || !contentType) return '';
  const base64 = Buffer.from(data).toString('base64');
  return `data:${contentType};base64,${base64}`;
};

const generateInviteCode = () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
};

const REQUIRED_FIELDS = [
  'displayName',
  'title',
  'bio',
  'specializations',
  'yearsOfExperience',
  'languages',
  'sessionModes',
  'timezone',
  'availabilityStatus',
  'calendlyUrl',
  'photo',
];

const getMissingFields = (profile) => {
  if (!profile) return [...REQUIRED_FIELDS];

  const missing = [];
  if (!profile.displayName) missing.push('displayName');
  if (!profile.title) missing.push('title');
  if (!profile.bio) missing.push('bio');
  if (!Array.isArray(profile.specializations) || profile.specializations.length === 0) {
    missing.push('specializations');
  }
  if (profile.yearsOfExperience === undefined || profile.yearsOfExperience === null) {
    missing.push('yearsOfExperience');
  }
  if (!Array.isArray(profile.languages) || profile.languages.length === 0) {
    missing.push('languages');
  }
  if (!Array.isArray(profile.sessionModes) || profile.sessionModes.length === 0) {
    missing.push('sessionModes');
  }
  if (!profile.timezone) missing.push('timezone');
  if (!profile.availabilityStatus) missing.push('availabilityStatus');
  if (!profile.calendlyUrl) missing.push('calendlyUrl');
  if (!profile.photo?.data) missing.push('photo');

  return missing;
};

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
  const missingFields = getMissingFields(therapistProfile);

  res.status(200).json({
    status: 'success',
    data: therapistProfile
      ? {
        ...therapistProfile.toObject(),
        photoUrl: buildPhotoUrl(therapistProfile),
      }
      : null,
    profileComplete: missingFields.length === 0,
    missingFields,
  });
});

exports.insertMyProfile = catchAsync(async (req, res) => {
  const updatePayload = buildUpdatePayload(req.body);

  const setOnInsert = {
    user: req.user._id,
  };
  if (updatePayload.displayName === undefined) {
    setOnInsert.displayName = req.user.name;
  }

  const therapistProfile = await TherapistProfile.findOneAndUpdate(
    { user: req.user._id },
    {
      $set: updatePayload,
      $setOnInsert: setOnInsert,
    },
    {
      new: true,
      upsert: true,
      runValidators: true,
      setDefaultsOnInsert: true,
    },
  );
  const missingFields = getMissingFields(therapistProfile);

  res.status(200).json({
    status: 'success',
    data: {
      ...therapistProfile.toObject(),
      photoUrl: buildPhotoUrl(therapistProfile),
    },
    profileComplete: missingFields.length === 0,
    missingFields,
  });
});

exports.updateMyPhoto = catchAsync(async (req, res, next) => {
  if (!req.file) {
    return next(new AppError('Profile photo is required.', 400));
  }

  const therapistProfile = await TherapistProfile.findOneAndUpdate(
    { user: req.user._id },
    {
      $set: {
        photo: {
          data: req.file.buffer,
          contentType: req.file.mimetype,
          updatedAt: new Date(),
        },
      },
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

  const missingFields = getMissingFields(therapistProfile);

  res.status(200).json({
    status: 'success',
    data: {
      ...therapistProfile.toObject(),
      photoUrl: buildPhotoUrl(therapistProfile),
    },
    profileComplete: missingFields.length === 0,
    missingFields,
  });
});

exports.getInviteCode = catchAsync(async (req, res) => {
  let profile = await TherapistProfile.findOne({ user: req.user._id });

  if (!profile) {
    profile = await TherapistProfile.create({
      user: req.user._id,
      displayName: req.user.name,
    });
  }

  if (!profile.inviteCode || profile.inviteCodeActive === false) {
    profile.inviteCode = generateInviteCode();
    profile.inviteCodeCreatedAt = new Date();
    profile.inviteCodeActive = true;
    await profile.save({ validateBeforeSave: false });
  }

  res.status(200).json({
    status: 'success',
    data: {
      inviteCode: profile.inviteCode,
      createdAt: profile.inviteCodeCreatedAt || null,
      active: profile.inviteCodeActive !== false,
    },
  });
});

exports.refreshInviteCode = catchAsync(async (req, res) => {
  let profile = await TherapistProfile.findOne({ user: req.user._id });

  if (!profile) {
    profile = await TherapistProfile.create({
      user: req.user._id,
      displayName: req.user.name,
    });
  }

  profile.inviteCode = generateInviteCode();
  profile.inviteCodeCreatedAt = new Date();
  profile.inviteCodeActive = true;
  await profile.save({ validateBeforeSave: false });

  res.status(200).json({
    status: 'success',
    data: {
      inviteCode: profile.inviteCode,
      createdAt: profile.inviteCodeCreatedAt || null,
      active: profile.inviteCodeActive !== false,
    },
  });
});
