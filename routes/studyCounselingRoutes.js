const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const studyCounselingController = require('../controllers/studyCounselingController');

router.post('/start', authController.protect, studyCounselingController.startOrGetSession);
router.patch('/details', authController.protect, studyCounselingController.saveDetails);
router.get('/my-session', authController.protect, studyCounselingController.getMySession);
router.get('/my-counselor', authController.protect, studyCounselingController.getMyCounselor);
router.get('/all', authController.protect, authController.isStudyCounselor, studyCounselingController.getAllSessions);
router.patch('/:userId/assign-counselor', authController.protect, authController.isStudyCounselor, studyCounselingController.assignCounselor);
router.patch('/:userId/assign-therapist', authController.protect, authController.isStudyCounselor, studyCounselingController.assignTherapistToStudent);
router.get('/available-therapists', authController.protect, authController.isStudyCounselor, studyCounselingController.getAvailableTherapists);

module.exports = router;
