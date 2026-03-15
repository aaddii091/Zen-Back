const express = require('express');
const authController = require('../controllers/authController');
const therapistSessionReportController = require('../controllers/therapistSessionReportController');

const router = express();

router.post(
  '/',
  authController.isTherapist,
  therapistSessionReportController.createOrUpsertReport,
);

router.get(
  '/',
  authController.isTherapist,
  therapistSessionReportController.getReports,
);

router.get(
  '/:id',
  authController.isTherapist,
  therapistSessionReportController.getReportById,
);

router.patch(
  '/:id',
  authController.isTherapist,
  therapistSessionReportController.updateReport,
);

module.exports = router;
