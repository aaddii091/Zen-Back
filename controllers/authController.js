const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');
const sendEmail = require('../utils/email');
const User = require('./../models/userModel');
const Quiz = require('./../models/quizModel');
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
  });
});
exports.signUp = catchAsync(async (req, res, next) => {
  console.log(req.body);

  const newUser = await User.create({
    name: req.body.name,
    email: req.body.email,
    password: req.body.password,
    passwordConfirm: req.body.passwordConfirm,
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
      new AppError('You are not logged in! Please log in to get access.', 401)
    );
  }
  const decoded = await promisify(jwt.verify)(token, process.env.JWT_SECRET);

  const freshUser = await User.findById(decoded.id);
  console.log(freshUser);
  if (!freshUser) {
    return next(
      new AppError('The user belonging to this token does no longer exist')
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
      new AppError('You are not logged in! Please log in to get access.', 401)
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

exports.forgotPassword = catchAsync(async (req, res, next) => {
  const user = await User.findOne({ email: req.body.email });
  if (!user) {
    return next(new AppError('There is no user with email address', 401));
  }
  const resetToken = await user.createPasswordResetToken();
  console.log(resetToken);
  await user.save({ validateBeforeSave: false });

  const resetURL = `${req.protocol}://${req.get(
    'host'
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
      new AppError('You are not logged in! Please log in to get access.', 401)
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
        404
      )
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
      new AppError('You are not logged in! Please log in to get access.', 401)
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
        404
      )
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
