const Organization = require('../models/organizationModel');
const TherapistProfile = require('../models/therapistProfileModel');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');

const buildTherapistPhotoUrl = (profile) => {
  const data = profile?.photo?.data;
  const contentType = profile?.photo?.contentType;
  if (!data || !contentType) return '';
  const base64 = Buffer.from(data).toString('base64');
  return `data:${contentType};base64,${base64}`;
};

const mapRosterItem = (therapistUser, therapistProfile) => ({
  therapistUserId: therapistUser?._id,
  displayName: therapistProfile?.displayName || therapistUser?.name || 'Therapist',
  title: therapistProfile?.title || 'Therapist',
  bio: therapistProfile?.bio || '',
  specializations: therapistProfile?.specializations || [],
  languages: therapistProfile?.languages || [],
  sessionModes: therapistProfile?.sessionModes || [],
  availabilityStatus: therapistProfile?.availabilityStatus || 'available',
  yearsOfExperience: therapistProfile?.yearsOfExperience ?? null,
  photoUrl: buildTherapistPhotoUrl(therapistProfile),
  profileType: therapistProfile?.profileType || 'professional_therapist',
  isDemoProfile: Boolean(therapistProfile?.isDemoProfile),
});

exports.createOrganization = catchAsync(async (req, res, next) => {
  const { organizationName, joinCode, therapistRoster } = req.body;
  if (!organizationName) {
    return next(new AppError('organizationName is required', 400));
  }

  const normalizedCode = String(joinCode || '').trim().toUpperCase();
  const roster = Array.isArray(therapistRoster)
    ? therapistRoster.filter(Boolean)
    : [];

  const organization = await Organization.create({
    organizationName,
    joinCode: normalizedCode || undefined,
    therapistRoster: roster,
  });

  res.status(201).json({ status: 'success', data: organization });
});

exports.getOrganizations = catchAsync(async (req, res, next) => {
  const organizations = await Organization.find().populate(
    'therapistRoster',
    'name email role',
  );

  res.status(200).json({
    status: 'success',
    results: organizations.length,
    data: organizations,
  });
});

exports.updateOrganization = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { organizationName, joinCode, joinCodeActive, therapistRoster } = req.body;
  const updates = {};

  if (organizationName) updates.organizationName = organizationName;
  if (joinCode !== undefined) {
    updates.joinCode = String(joinCode || '').trim().toUpperCase();
  }
  if (joinCodeActive !== undefined) {
    updates.joinCodeActive = Boolean(joinCodeActive);
  }
  if (Array.isArray(therapistRoster)) {
    updates.therapistRoster = therapistRoster.filter(Boolean);
  }

  if (!Object.keys(updates).length) {
    return next(new AppError('At least one organization field is required', 400));
  }

  const organization = await Organization.findByIdAndUpdate(
    id,
    updates,
    { new: true, runValidators: true }
  );

  if (!organization) {
    return next(new AppError('Organization not found', 404));
  }

  res.status(200).json({ status: 'success', data: organization });
});

exports.redeemOrganizationCode = catchAsync(async (req, res, next) => {
  if (req.user.role !== 'user') {
    return next(new AppError('Only users can redeem organization codes.', 403));
  }

  const rawCode = String(req.body?.code || '').trim().toUpperCase();
  if (!rawCode) {
    return next(new AppError('Organization code is required.', 400));
  }

  const organization = await Organization.findOne({
    joinCode: rawCode,
    joinCodeActive: { $ne: false },
  }).lean();

  if (!organization) {
    return next(new AppError('Organization code not found or inactive.', 404));
  }

  const previousOrganizationId = req.user.organization || null;
  req.user.organization = organization._id;
  await req.user.save({ validateBeforeSave: false });

  res.status(200).json({
    status: 'success',
    data: {
      organizationId: organization._id,
      organizationName: organization.organizationName,
      alreadyJoined: String(previousOrganizationId || '') === String(organization._id),
      hasSelectedOrgTherapist: Boolean(req.user.hasSelectedOrgTherapist),
    },
  });
});

exports.getMyTherapistRoster = catchAsync(async (req, res, next) => {
  if (req.user.role !== 'user') {
    return next(new AppError('Only users can access organization therapists.', 403));
  }

  if (!req.user.organization) {
    return res.status(200).json({
      status: 'success',
      data: {
        organization: null,
        hasSelectedOrgTherapist: Boolean(req.user.hasSelectedOrgTherapist),
        selectedTherapistId: req.user.assignedTherapist || null,
        roster: [],
      },
    });
  }

  const organization = await Organization.findById(req.user.organization)
    .populate('therapistRoster', 'name role')
    .lean();

  if (!organization) {
    return next(new AppError('Organization not found.', 404));
  }

  const therapistUsers = (organization.therapistRoster || []).filter(
    (item) => item?.role === 'therapist',
  );
  const therapistIds = therapistUsers.map((item) => item._id);
  const therapistProfiles = await TherapistProfile.find({
    user: { $in: therapistIds },
  }).lean();

  const profileMap = new Map(
    therapistProfiles.map((profile) => [String(profile.user), profile]),
  );

  const roster = therapistUsers.map((therapistUser) =>
    mapRosterItem(therapistUser, profileMap.get(String(therapistUser._id))));

  res.status(200).json({
    status: 'success',
    data: {
      organization: {
        id: organization._id,
        name: organization.organizationName,
      },
      hasSelectedOrgTherapist: Boolean(req.user.hasSelectedOrgTherapist),
      selectedTherapistId: req.user.assignedTherapist || null,
      roster,
    },
  });
});
