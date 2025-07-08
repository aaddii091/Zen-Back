const Organization = require('../models/organizationModel');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');

exports.createOrganization = catchAsync(async (req, res, next) => {
  const { organizationName } = req.body;
  if (!organizationName) {
    return next(new AppError('organizationName is required', 400));
  }

  const organization = await Organization.create({ organizationName });

  res.status(201).json({ status: 'success', data: organization });
});

exports.getOrganizations = catchAsync(async (req, res, next) => {
  const organizations = await Organization.find();

  res.status(200).json({
    status: 'success',
    results: organizations.length,
    data: organizations,
  });
});

exports.updateOrganization = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { name } = req.body;
  if (!name) {
    return next(new AppError('name is required', 400));
  }

  const organization = await Organization.findOneAndUpdate(
    { name },
    { new: true, runValidators: true }
  );

  if (!organization) {
    return next(new AppError('Organization not found', 404));
  }

  res.status(200).json({ status: 'success', data: organization });
});
