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
router.patch(
  '/photo',
  authController.isTherapist,
  therapistProfileController.uploadTherapistPhoto,
  therapistProfileController.updateMyPhoto,
);
router.get(
  '/invite-code',
  authController.isTherapist,
  therapistProfileController.getInviteCode,
);
router.post(
  '/invite-code/refresh',
  authController.isTherapist,
  therapistProfileController.refreshInviteCode,
);

module.exports = router;
