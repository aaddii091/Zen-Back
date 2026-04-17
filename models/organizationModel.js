const mongoose = require('mongoose');

const organizationSchema = new mongoose.Schema({
  organizationName: {
    type: String,
    required: [true, 'Organization name is required'],
    unique: true,
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
  therapistRoster: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  ],
});

module.exports = mongoose.model('Organization', organizationSchema);
