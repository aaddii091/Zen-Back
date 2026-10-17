const mongoose = require('mongoose');

const studentImportRowResultSchema = new mongoose.Schema(
  {
    rowNumber: { type: Number, required: true },
    email: { type: String, trim: true, default: '' },
    name: { type: String, trim: true, default: '' },
    status: { type: String, enum: ['created', 'failed'], required: true },
    message: { type: String, trim: true, default: '' },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { _id: false },
);

const studentImportJobSchema = new mongoose.Schema(
  {
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    fileName: {
      type: String,
      trim: true,
      default: '',
    },
    status: {
      type: String,
      enum: ['queued', 'processing', 'completed', 'failed'],
      default: 'queued',
    },
    totalRows: { type: Number, default: 0 },
    createdCount: { type: Number, default: 0 },
    failedCount: { type: Number, default: 0 },
    rowResults: {
      type: [studentImportRowResultSchema],
      default: [],
    },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    errorMessage: { type: String, trim: true, default: '' },
    _csvPayload: { type: String, default: '', select: false },
  },
  { timestamps: true },
);

studentImportJobSchema.index({ organization: 1, createdAt: -1 });
studentImportJobSchema.index({ createdBy: 1, createdAt: -1 });

module.exports = mongoose.model('StudentImportJob', studentImportJobSchema);
