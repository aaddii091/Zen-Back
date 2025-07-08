const mongoose = require('mongoose');

const organizationSchema = new mongoose.Schema({
  organizationId: {
    type: String,
    required: [true, 'Organization ID is required'],
    unique: true,
  },
  name: {
    type: String,
    required: [true, 'Organization name is required'],
    unique: true,
  },
});

module.exports = mongoose.model('Organization', organizationSchema);
