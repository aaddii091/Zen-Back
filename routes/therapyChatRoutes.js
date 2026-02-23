const express = require('express');
const authController = require('../controllers/authController');
const therapyChatController = require('../controllers/therapyChatController');
const chatRateLimit = require('../middleware/chatRateLimit');

const router = express.Router();

router.get('/thread', authController.protect, chatRateLimit, therapyChatController.getThread);
router.post('/message', authController.protect, chatRateLimit, therapyChatController.sendMessage);

module.exports = router;
