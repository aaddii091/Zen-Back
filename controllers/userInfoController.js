const catchAsync = require('../utils/catchAsync');
const UserInfo = require('../models/userInfoModel');

const normalizePrimaryConcern = (value) => {
  if (!value) return value;
  const normalized = String(value).toLowerCase().trim().replace(/\s+/g, '_');
  const map = {
    workburnout: 'work_burnout',
  };
  return map[normalized] || normalized;
};

const normalizeTherapistGender = (value) => {
  if (!value) return value;
  const normalized = String(value).toLowerCase().trim().replace(/\s+/g, '_');
  if (normalized === 'none' || normalized === 'no-preference') {
    return 'no_preference';
  }
  return normalized;
};

const normalizeSessionMode = (value) => {
  if (!value) return value;
  const normalized = String(value).toLowerCase().trim().replace(/\s+/g, '_');
  if (normalized === 'yes' || normalized === 'zoom') return 'zoom_video';
  if (normalized === 'prefer_something_else') return 'prefer_something_else';
  return normalized;
};

const normalizeReminderChannel = (value) => {
  if (!value) return value;
  const normalized = String(value).toLowerCase().trim().replace(/\s+/g, '_');
  if (
    normalized === 'whatsapp' ||
    normalized === 'sms' ||
    normalized === 'sms/whatsapp'
  ) {
    return 'sms_whatsapp';
  }
  if (normalized === 'none' || normalized === 'no') return 'no_reminders';
  return normalized;
};

const normalizeAvailability = (value) => {
  if (!value) return value;
  const values = Array.isArray(value) ? value : [value];
  return values.map((item) =>
    String(item).toLowerCase().trim().replace(/\s+/g, '_'),
  );
};

const buildUpdatePayload = (body = {}) => {
  const payload = {};

  if (body.primaryConcern !== undefined) {
    payload.primaryConcern = normalizePrimaryConcern(body.primaryConcern);
  }
  if (body.therapistGenderPref !== undefined) {
    payload.therapistGenderPref = normalizeTherapistGender(
      body.therapistGenderPref,
    );
  }
  if (body.languagePref !== undefined) payload.languagePref = body.languagePref;
  if (body.sessionMode !== undefined) {
    payload.sessionMode = normalizeSessionMode(body.sessionMode);
  }
  if (body.availabilityPrefs !== undefined) {
    payload.availabilityPrefs = normalizeAvailability(body.availabilityPrefs);
  }
  if (body.timezone !== undefined) payload.timezone = body.timezone;
  if (body.reminderChannel !== undefined) {
    payload.reminderChannel = normalizeReminderChannel(body.reminderChannel);
  }
  if (body.trustedContact !== undefined) {
    payload.trustedContact = {
      enabled: Boolean(body.trustedContact?.enabled),
      name: body.trustedContact?.name || '',
      email: body.trustedContact?.email || '',
      relationship: body.trustedContact?.relationship || '',
    };
  }

  return payload;
};

exports.getMyInfo = catchAsync(async (req, res) => {
  const userInfo = await UserInfo.findOne({ user: req.user._id });

  res.status(200).json({
    status: 'success',
    data: userInfo,
  });
});

exports.insertMyInfo = catchAsync(async (req, res) => {
  const updatePayload = buildUpdatePayload(req.body);

  const userInfo = await UserInfo.findOneAndUpdate(
    { user: req.user._id },
    { $set: updatePayload, $setOnInsert: { user: req.user._id } },
    {
      new: true,
      upsert: true,
      runValidators: true,
      setDefaultsOnInsert: true,
    },
  );

  res.status(200).json({
    status: 'success',
    data: userInfo,
  });
});
