const mongoose = require('mongoose');

const adminAuditLogSchema = new mongoose.Schema(
  {
    actor: {
      id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      email: { type: String, trim: true },
      name: { type: String, trim: true },
    },
    actionType: {
      type: String,
      required: true,
      trim: true,
    },
    targetType: {
      type: String,
      required: true,
      trim: true,
    },
    targetId: {
      type: String,
      trim: true,
      default: '',
    },
    reason: {
      type: String,
      trim: true,
      default: '',
    },
    before: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    after: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    requestMeta: {
      ip: { type: String, trim: true, default: '' },
      method: { type: String, trim: true, default: '' },
      path: { type: String, trim: true, default: '' },
      userAgent: { type: String, trim: true, default: '' },
    },
  },
  { timestamps: true },
);

adminAuditLogSchema.index({ createdAt: -1 });
adminAuditLogSchema.index({ actionType: 1, createdAt: -1 });
adminAuditLogSchema.index({ targetType: 1, targetId: 1 });

module.exports = mongoose.model('AdminAuditLog', adminAuditLogSchema);
