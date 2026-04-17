const express = require('express');
const authController = require('../controllers/authController');
const aiTherapyController = require('../controllers/aiTherapyController');

const router = express.Router();

router.post(
  '/voice-session',
  authController.protect,
  aiTherapyController.createTherapyVoiceSession,
);

router.post(
  '/sessions/:id/finalize',
  authController.protect,
  aiTherapyController.finalizeTherapySession,
);

router.post(
  '/sessions/:id/abort',
  authController.protect,
  aiTherapyController.abortTherapySession,
);

router.get('/reports', authController.protect, aiTherapyController.getMyTherapyReports);
router.get('/reports/:id', authController.protect, aiTherapyController.getMyTherapyReportById);

module.exports = router;
