const mongoose = require('mongoose');

const organizationSchema = new mongoose.Schema(
  {
    // Legacy identifier field kept for backward compatibility with old DB index `organizationId_1`.
    organizationId: {
      type: String,
      trim: true,
      unique: true,
      sparse: true,
    },
    // Legacy field kept to satisfy existing unique index `name_1` in old DBs.
    name: {
      type: String,
      trim: true,
      unique: true,
      sparse: true,
    },
    organizationName: {
      type: String,
      required: [true, 'Organization name is required'],
      unique: true,
      trim: true,
    },
    type: {
      type: String,
      trim: true,
      default: '',
    },
    boardAffiliation: {
      type: String,
      trim: true,
      default: '',
    },
    studentCap: {
      type: Number,
      min: 0,
      default: 0,
    },
    city: {
      type: String,
      trim: true,
      default: '',
    },
    status: {
      type: String,
      enum: ['active', 'onboarding', 'beta', 'suspended', 'churned'],
      default: 'onboarding',
    },
    complianceFramework: {
      type: String,
      enum: ['sc_only', 'sc_cbse', 'sc_ugc'],
      default: 'sc_only',
    },
    accountOwner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    joinCode: {
      type: String,
      trim: true,
      uppercase: true,
      unique: true,
      sparse: true,
    },
    joinCodeActive: {
      type: Boolean,
      default: true,
    },
    joinCodeCreatedAt: {
      type: Date,
      default: null,
    },
    joinCodeRevokedAt: {
      type: Date,
      default: null,
    },
    therapistRoster: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
  },
  { timestamps: true },
);

organizationSchema.index({ organizationName: 1 });
organizationSchema.index({ type: 1, city: 1, boardAffiliation: 1, status: 1 });
organizationSchema.index({ studentCap: 1 });

module.exports = mongoose.model('Organization', organizationSchema);
