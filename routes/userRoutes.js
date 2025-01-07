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

module.exports = router;
