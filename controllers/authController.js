const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');
const sendEmail = require('../utils/email');
const User = require('./../models/userModel');
const Quiz = require('./../models/quizModel');
const TherapistProfile = require('./../models/therapistProfileModel');
const jwt = require('jsonwebtoken');
const { promisify } = require('util');
const crypto = require('crypto');
const { log } = require('console');

const signToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN,
  });
};

exports.login = catchAsync(async (req, res, next) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return next(new AppError('Please provide username and password', 400));
  }
  const user = await User.findOne({ email }).select('+password');
  if (!user || !(await user.correctPassword(password, user.password))) {
    return next(new AppError('User or Password is Wrong ', 401));
  }
  const token = signToken(user._id);
  res.status(200).json({
    status: 'success',
    message: 'Logged In Successfully',
    token: token,
    role: user.role,
    hasOnboarded: user.hasOnboarded,
    user: {
      id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
    },
  });
});
exports.signUp = catchAsync(async (req, res, next) => {
  console.log(req.body);
  const allowedSignupRoles = ['user', 'therapist'];
  const role = allowedSignupRoles.includes(req.body.role)
    ? req.body.role
    : undefined;

  const newUser = await User.create({
    name: req.body.name,
    email: req.body.email,
    password: req.body.password,
    passwordConfirm: req.body.passwordConfirm,
    role,
  });

  const token = signToken(newUser._id);

  // Send a success response
  res.status(200).json({
    status: 'success',
    data: {
      user: newUser, // Include the newly created user in the response
      token: token,
    },
  });
});
exports.protect = catchAsync(async (req, res, next) => {
  let token;
  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return next(
      new AppError('You are not logged in! Please log in to get access.', 401),
    );
  }
  const decoded = await promisify(jwt.verify)(token, process.env.JWT_SECRET);

  const freshUser = await User.findById(decoded.id);
  console.log(freshUser);
  if (!freshUser) {
    return next(
      new AppError('The user belonging to this token does no longer exist'),
    );
  }

  req.user = freshUser;
  next();
});
exports.isAdmin = catchAsync(async (req, res, next) => {
  let token;
  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return next(
      new AppError('You are not logged in! Please log in to get access.', 401),
    );
  }
  const decoded = await promisify(jwt.verify)(token, process.env.JWT_SECRET);

  const freshUser = await User.findById(decoded.id);
  console.log(freshUser);
  if (freshUser.role !== 'admin') {
    return next(new AppError('The user is not an admin'));
  }

  req.user = freshUser;

  next();
});
exports.isTherapist = catchAsync(async (req, res, next) => {
  let token;
  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return next(
      new AppError('You are not logged in! Please log in to get access.', 401),
    );
  }
  const decoded = await promisify(jwt.verify)(token, process.env.JWT_SECRET);

  const freshUser = await User.findById(decoded.id);
  console.log(freshUser);
  if (!freshUser || freshUser.role !== 'therapist') {
    return next(new AppError('The user is not a therapist', 403));
  }

  req.user = freshUser;

  next();
});

exports.assignTherapistToUser = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { therapistUserId } = req.body;

  if (!therapistUserId) {
    return next(new AppError('therapistUserId is required', 400));
  }

  const targetUser = await User.findById(id);
  if (!targetUser) {
    return next(new AppError('User not found', 404));
  }
  if (targetUser.role !== 'user') {
    return next(
      new AppError('Only users with role "user" can be assigned a therapist', 400),
    );
  }

  const therapistUser = await User.findById(therapistUserId);
  if (!therapistUser) {
    return next(new AppError('Therapist user not found', 404));
  }
  if (therapistUser.role !== 'therapist') {
    return next(new AppError('Provided therapistUserId is not a therapist', 400));
  }

  targetUser.assignedTherapist = therapistUser._id;
  await targetUser.save({ validateBeforeSave: false });

  res.status(200).json({
    status: 'success',
    data: {
      userId: targetUser._id,
      assignedTherapist: therapistUser._id,
    },
  });
});

exports.getAssignedTherapist = catchAsync(async (req, res, next) => {
  const user = await User.findById(req.user._id)
    .select('assignedTherapist')
    .populate('assignedTherapist', 'name role');

  if (!user?.assignedTherapist) {
    return res.status(200).json({
      status: 'success',
      data: null,
    });
  }

  const therapistUser = user.assignedTherapist;
  const therapistProfile = await TherapistProfile.findOne({
    user: therapistUser._id,
  });

  res.status(200).json({
    status: 'success',
    data: {
      therapistUserId: therapistUser._id,
      displayName: therapistProfile?.displayName || therapistUser.name,
      title: therapistProfile?.title || 'Therapist',
      bio: therapistProfile?.bio || '',
      specializations: therapistProfile?.specializations || [],
      languages: therapistProfile?.languages || [],
      sessionModes: therapistProfile?.sessionModes || [],
      availabilityStatus: therapistProfile?.availabilityStatus || 'available',
      calendlyUrl: therapistProfile?.calendlyUrl || '',
    },
  });
});

exports.getMe = catchAsync(async (req, res) => {
  res.status(200).json({
    status: 'success',
    data: {
      id: req.user._id,
      name: req.user.name,
      email: req.user.email,
      role: req.user.role,
      hasOnboarded: req.user.hasOnboarded,
      assignedTherapist: req.user.assignedTherapist || null,
    },
  });
});

exports.forgotPassword = catchAsync(async (req, res, next) => {
  const user = await User.findOne({ email: req.body.email });
  if (!user) {
    return next(new AppError('There is no user with email address', 401));
  }
  const resetToken = await user.createPasswordResetToken();
  console.log(resetToken);
  await user.save({ validateBeforeSave: false });

  const resetURL = `${req.protocol}://${req.get(
    'host',
  )}/api/v1/users/resetPassword/${resetToken}`;

  const message = `Forgot your password ? Submit a PATCH request with your new password & passwordConfirm to: ${resetURL}`;
  try {
    await sendEmail({
      email: user.email,
      subject: 'Your Password Reset',
      message,
    });
    res.status(200).json({
      status: 'success',
      message: 'Token sent to mail',
    });
  } catch (err) {
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save({
      validateBeforeSave: false,
    });
  }
});

exports.resetPassword = catchAsync(async (req, res, next) => {
  const hashedToken = crypto
    .createHash('sha256')
    .update(req.params.token)
    .digest('hex');

  const user = await User.findOne({
    passwordResetToken: hashedToken,
    passwordResetExpires: { $gt: Date.now() },
  });

  if (!user) {
    return next(new AppError('Token is expired or invalid', 400));
  }
  user.password = req.body.password;
  user.passwordConfirm = req.body.passwordConfirm;
  user.passwordResetToken = undefined;
  user.passwordResetExpires = undefined;
  await user.save();

  const token = signToken(user._id);
  res.status(200).json({
    status: 'success',
    token,
  });
});

exports.updatePassword = catchAsync(async (req, res, next) => {
  //geting user from collection
  const user = await User.findById(req.user._id.toString()).select('+password');
  //checking if the current password is correct
  if (user.correctPassword(user.password, req.body.password)) {
    console.log('correct password');
    user.password = req.body.newPassword;
    user.passwordConfirm = req.body.newPasswordConfirm;
    await user.save();
  }
  const token = signToken(user._id);
  res.status(200).json({
    status: 'success',
    message: 'Logged In Successfully',
    token: token,
  });
});
exports.getUserQuizzes = catchAsync(async (req, res, next) => {
  let token;

  // Extract token from Authorization header
  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return next(
      new AppError('You are not logged in! Please log in to get access.', 401),
    );
  }

  // Verify and decode the token
  const decoded = await promisify(jwt.verify)(token, process.env.JWT_SECRET);

  // Fetch user details using decoded ID
  const user = await User.findById(decoded.id);

  if (!user) {
    return next(
      new AppError(
        'The user belonging to this token does no longer exist.',
        404,
      ),
    );
  }

  // Fetch quizzes using the IDs in the user's accessibleQuizzes array
  const quizzes = await Quiz.find({
    _id: { $in: user.accessibleQuizzes },
  });

  // If no quizzes are found
  if (!quizzes || quizzes.length === 0) {
    return next(new AppError('No quizzes found for this user.', 404));
  }

  // Respond with the quizzes
  res.status(200).json({
    message: 'User quizzes retrieved successfully',
    quizzes,
  });
});
exports.getQuizByID = catchAsync(async (req, res, next) => {
  let token;

  const { id } = req.body;
  console.log(req.body);

  // Extract token from Authorization header
  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return next(
      new AppError('You are not logged in! Please log in to get access.', 401),
    );
  }

  // Verify and decode the token
  const decoded = await promisify(jwt.verify)(token, process.env.JWT_SECRET);

  // Fetch user details using decoded ID
  const user = await User.findById(decoded.id);

  if (!user) {
    return next(
      new AppError(
        'The user belonging to this token does no longer exist.',
        404,
      ),
    );
  }

  // Fetch quizzes using the `$in` operator
  const quiz = await Quiz.find({
    _id: { $in: id },
  });

  // If no quiz are found
  if (!quiz || quiz.length === 0) {
    return next(new AppError(`No quiz found for the provided ID ${id}.`, 404));
  }

  // Respond with the quiz
  res.status(200).json({
    message: 'User quiz retrieved successfully',
    quiz,
  });
});
