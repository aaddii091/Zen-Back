const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const careerAssessmentController = require('../controllers/careerAssessmentController');

router.post('/start', authController.protect, careerAssessmentController.startOrGetAssessment);
router.patch('/phase1', authController.protect, careerAssessmentController.savePhase1);
router.patch('/phase2', authController.protect, careerAssessmentController.savePhase2);
router.get('/my-report', authController.protect, careerAssessmentController.getMyReport);
router.post('/book', authController.protect, careerAssessmentController.bookSession);
router.get('/all', authController.protect, authController.isCareerCounselor, careerAssessmentController.getAllAssessments);

module.exports = router;
