const express = require('express');
const authController = require('../controllers/authController');
const therapistProfileController = require('../controllers/therapistProfileController');

const router = express();

router.get(
  '/',
  authController.isTherapist,
  therapistProfileController.getMyProfile,
);
router.patch(
  '/',
  authController.isTherapist,
  therapistProfileController.insertMyProfile,
);

module.exports = router;
