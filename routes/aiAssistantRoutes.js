const express = require('express');
const authController = require('../controllers/authController');
const aiAssistantController = require('../controllers/aiAssistantController');

const router = express.Router();

router.post('/chat', authController.protect, aiAssistantController.chat);

module.exports = router;
