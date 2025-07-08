const mongoose = require('mongoose');

const organizationSchema = new mongoose.Schema({
  organizationName: {
    type: String,
    required: [true, 'Organization name is required'],
    unique: true,
  },
});

module.exports = mongoose.model('Organization', organizationSchema);
