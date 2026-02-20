const express = require('express');
const voiceSession = require('../AIAgents/voiceSession');
const authController = require('../controllers/authController');

const router = express.Router();

router.post('/session', authController.protect, voiceSession.createVoiceSession);

module.exports = router;
