const express = require('express');
const authController = require('./../controllers/authController');
const router = express();

router.get('/login', authController.protect, (req, res, next) => {
  res.status(200).json({
    message: 'Good',
  });
});

router.get('/protect-test', authController.isAdmin, (req, res, next) => {
  res.status(200).json({
    message: 'Working Protect',
  });
});
router.post('/signup', authController.signUp);
router.post('/test', (req, res) => {
  res.status(200).send('working');
});
router.post('/login', authController.login);
router.post(
  '/updatePassword',
  authController.protect,
  authController.updatePassword
);

router.post('/forgotPassword', authController.forgotPassword);
router.post('/resetPassword/:token', authController.resetPassword);

router.get('/getUserQuizzes', authController.getUserQuizzes);
router.post('/getQuizByID', authController.getQuizByID);
router.get('/me', authController.protect, authController.getMe);
router.get('/my-session-overview', authController.protect, authController.getMySessionOverview);
router.get(
  '/my-assigned-clients',
  authController.isTherapist,
  authController.getMyAssignedClients,
);
router.get(
  '/quiz-library',
  authController.isTherapist,
  authController.getTherapistQuizLibrary,
);
router.get(
  '/therapist-client/:id/quiz-assignments',
  authController.isTherapist,
  authController.getTherapistClientQuizAssignments,
);
router.post(
  '/therapist-client/:id/quiz-assignments',
  authController.isTherapist,
  authController.assignQuizToTherapistClient,
);
router.patch(
  '/therapist-client/:id/quiz-assignments/:assignmentId',
  authController.isTherapist,
  authController.updateTherapistClientQuizAssignment,
);
router.get(
  '/therapist-client/:id/overview',
  authController.isTherapist,
  authController.getTherapistClientOverview,
);
router.get('/assigned-therapist', authController.protect, authController.getAssignedTherapist);
router.patch(
  '/:id/assign-therapist',
  authController.isAdmin,
  authController.assignTherapistToUser
);

module.exports = router;
