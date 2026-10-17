const express = require('express');
const authController = require('../controllers/authController');
const escalationController = require('../controllers/escalationController');

const router = express.Router();

// Literal paths MUST be declared before '/:id', or Express binds id = 'mine'.

/* counsellor */
router.post(
  '/',
  authController.protect,
  authController.restrictTo('therapist'),
  escalationController.createEscalation,
);
router.get(
  '/mine',
  authController.protect,
  authController.restrictTo('therapist'),
  escalationController.getMyEscalations,
);

/* school admin */
router.get(
  '/inbox',
  authController.protect,
  authController.restrictTo('school_admin'),
  escalationController.getEscalationInbox,
);
router.get(
  '/inbox/counts',
  authController.protect,
  authController.restrictTo('school_admin'),
  escalationController.getEscalationCounts,
);
router.get(
  '/inbox/:id',
  authController.protect,
  authController.restrictTo('school_admin'),
  escalationController.getEscalationForAdmin,
);
router.patch(
  '/:id/status',
  authController.protect,
  authController.restrictTo('school_admin'),
  escalationController.updateEscalationStatus,
);
router.post(
  '/:id/parent-contact',
  authController.protect,
  authController.restrictTo('school_admin'),
  escalationController.recordParentContact,
);

module.exports = router;
