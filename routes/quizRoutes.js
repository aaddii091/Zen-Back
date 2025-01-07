const express = require('express');
const authController = require('../controllers/authController');
const quizController = require('../controllers/quizController');

const router = express.Router();

// Middleware to check if the user is an admin
const isAdmin = (req, res, next) => {
  console.log(req.user);
  if (req.user && req.user.role === 'admin') {
    next();
  } else {
    res.status(403).json({ message: 'Access Denied: Admins Only' });
  }
};

router.get('/quiz-test', authController.isAdmin, async (req, res) => {
  return res.status(400).json({ message: 'Route is working' });
});

// Route to create a new quiz
router.post('/create-quiz', authController.isAdmin, quizController.createQuiz);
// router.post('/create-pool-quiz', authController.isAdmin, quizController.createPollQuiz);

module.exports = router;
