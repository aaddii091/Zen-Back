const express = require('express');
const authController = require('../controllers/authController');
const referralController = require('../controllers/referralController');

const router = express.Router();

// Literal paths before '/:id'.

/* therapist — the shared inbox for the school's help group */
router.get(
  '/inbox',
  authController.protect,
  authController.restrictTo('therapist'),
  referralController.getReferralInbox,
);
router.get(
  '/inbox/counts',
  authController.protect,
  authController.restrictTo('therapist'),
  referralController.getReferralInboxCounts,
);
router.get(
  '/inbox/:id',
  authController.protect,
  authController.restrictTo('therapist'),
  referralController.getReferralForTherapist,
);
router.patch(
  '/:id/claim',
  authController.protect,
  authController.restrictTo('therapist'),
  referralController.claimReferral,
);
router.patch(
  '/:id/status',
  authController.protect,
  authController.restrictTo('therapist'),
  referralController.updateReferralStatus,
);

/* teacher */
router.get(
  '/mine',
  authController.protect,
  authController.restrictTo('teacher'),
  referralController.getMyReferrals,
);
router.post(
  '/',
  authController.protect,
  authController.restrictTo('teacher'),
  referralController.createReferral,
);
router.get(
  '/:id',
  authController.protect,
  authController.restrictTo('teacher'),
  referralController.getMyReferralById,
);
router.post(
  '/:id/teacher-note',
  authController.protect,
  authController.restrictTo('teacher'),
  referralController.addTeacherNote,
);
router.patch(
  '/:id/withdraw',
  authController.protect,
  authController.restrictTo('teacher'),
  referralController.withdrawReferral,
);

module.exports = router;
