const express = require('express');
const authController = require('../controllers/authController');
const calendlyController = require('../controllers/calendlyController');

const router = express.Router();

router.get('/connect-url', authController.isTherapist, calendlyController.getConnectUrl);
router.get('/callback', calendlyController.callback);
router.post('/webhook', calendlyController.webhook);
router.get('/status', authController.isTherapist, calendlyController.status);
router.get('/today-sessions', authController.isTherapist, calendlyController.todaySessions);
router.get('/upcoming-sessions', authController.isTherapist, calendlyController.upcomingSessions);
router.get('/my-bookings', authController.isTherapist, calendlyController.myBookings);
router.post('/disconnect', authController.isTherapist, calendlyController.disconnect);

module.exports = router;
