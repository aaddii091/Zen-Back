const express = require('express');
const voiceSession = require('../AIAgents/voiceSession');

const router = express.Router();

router.post('/session', voiceSession.createVoiceSession);

module.exports = router;
