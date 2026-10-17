const mongoose = require('mongoose');

const ticketSchema = new mongoose.Schema({
  title: {
    type: String,
    required: [true, 'Ticket title is required'],
    trim: true,
  },
  message: {
    type: String,
    required: [true, 'Ticket message is required'],
    trim: true,
  },
  kind: {
    type: String,
    enum: ['support', 'incident', 'complaint'],
    default: 'support',
  },
  issueTypes: {
    type: [String],
    default: [],
  },
  anonymous: {
    type: Boolean,
    default: false,
  },
  reporterSnapshot: {
    name: { type: String, trim: true, default: '' },
    email: { type: String, trim: true, default: '' },
    role: { type: String, trim: true, default: '' },
  },
  requestImmediateSupport: {
    type: Boolean,
    default: false,
  },
  retaliationRisk: {
    type: Boolean,
    default: false,
  },
  location: {
    type: String,
    trim: true,
    default: '',
  },
  occurredAt: {
    type: Date,
    default: null,
  },
  status: {
    type: String,
    enum: ['queued', 'in_progress', 'addressed'],
    default: 'queued',
  },
  internalNotes: {
    type: String,
    trim: true,
    default: '',
  },
  addressedAt: {
    type: Date,
    default: null,
  },
  addressedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  // Store uploaded image in MongoDB
  file: {
    data: Buffer,
    contentType: String,
  },
  organization: {
    type: String,
    trim: true,
    default: '',
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  createdAt: { type: Date, default: Date.now },
});

ticketSchema.index({ kind: 1, status: 1, createdAt: 1 });
ticketSchema.index({ createdBy: 1, createdAt: -1 });

module.exports = mongoose.model('Ticket', ticketSchema);
