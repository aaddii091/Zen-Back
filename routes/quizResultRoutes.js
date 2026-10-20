const express = require('express');
const authController = require('../controllers/authController');
const quizResultController = require('../controllers/quizResultController');

const router = express.Router();

// Counsellor-only. Every handler also checks that the student is assigned to
// the caller, so the role guard alone is never what protects a result.
router.use(authController.protect, authController.restrictTo('therapist'));

router.get('/student/:studentId', quizResultController.listStudentQuizResults);
router.get('/:assignmentId', quizResultController.getStudentQuizResult);
router.patch('/:assignmentId/note', quizResultController.setQuizResultNote);

module.exports = router;
