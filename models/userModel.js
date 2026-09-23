const mongoose = require('mongoose');
const validator = require('validator');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Please tell us your name!'],
  },
  // New users should not receive admin rights automatically
  role: { type: String, enum: ['admin', 'user', 'teacher', 'therapist', 'career_counselor', 'study_counselor'], default: 'user' },
  roles: {
    type: [{ type: String, enum: ['admin', 'user', 'teacher', 'therapist', 'career_counselor', 'study_counselor'] }],
    default: [],
  },
  hasOnboarded: { type: Boolean, default: false },
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    default: null,
  },
  hasSelectedOrgTherapist: {
    type: Boolean,
    default: false,
  },
  // Single source of truth for classroom membership — a student is in exactly one
  // classroom at a time. There is deliberately no students[] array on Classroom.
  classroom: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Classroom',
    default: null,
    index: true,
  },
  assignedTherapist: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  assignedCareerCounselor: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  assignedStudyCounselor: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  hasCompletedRecommendationTest: { type: Boolean, default: false },
  recommendationTestResult: {
    category: { type: String, enum: ['study_coach_recommended', 'professional_therapist_recommended'], default: null },
    totalScore: { type: Number, default: 0 },
    traitScores: { type: mongoose.Schema.Types.Mixed, default: {} },
    completedAt: { type: Date, default: null },
  },
  accessibleQuizzes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Quiz' }],
  attemptedQuizzes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Quiz' }],
  email: {
    type: String,
    lowercase: true,
    required: [true, 'Please provide an email'],
    unique: true,
    validate: [validator.isEmail, 'Please provide a valid email'],
  },
  password: {
    type: String,
    required: [true, 'Please provide a password'],
    minlength: 8,
    select: false,
  },
  passwordConfirm: {
    type: String,
    required: [true, 'Please confirm your password'],
    validate: {
      // This only works on CREATE and SAVE!!!
      validator: function (el) {
        return el === this.password;
      },
      message: 'Passwords are not the same!',
    },
  },
  passwordChangedAt: Date,
  passwordResetToken: String,
  passwordResetExpires: Date,
});

//METHODS
userSchema.methods.correctPassword = async function (
  candidatePassword,
  userPassword,
) {
  return await bcrypt.compare(candidatePassword, userPassword);
};

userSchema.methods.createPasswordResetToken = async function () {
  const resetToken = crypto.randomBytes(32).toString('hex');

  this.passwordResetToken = crypto
    .createHash('sha256')
    .update(resetToken)
    .digest('hex');

  console.log({ resetToken }, this.passwordResetToken);
  this.passwordResetExpires = Date.now() + 10 * 60 * 1000;
  return resetToken;
};

userSchema.index({ classroom: 1, role: 1 });

// Keep roles[] in sync — primary role is always present in the array
userSchema.pre('save', function (next) {
  if (this.role && !this.roles.includes(this.role)) {
    this.roles.push(this.role);
  }
  next();
});

userSchema.pre('save', async function (next) {
  // Only run this function if password was actually modified
  if (!this.isModified('password')) return next();

  // Hash the password with cost of 12
  this.password = await bcrypt.hash(this.password, 12);

  // Delete passwordConfirm field
  this.passwordConfirm = undefined;
  next();
});

const User = mongoose.model('User', userSchema);

module.exports = User;
