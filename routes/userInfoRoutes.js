const express = require('express');
const authController = require('../controllers/authController');
const userInfoController = require('../controllers/userInfoController');

const router = express();

router.get('/', authController.protect, userInfoController.getMyInfo);
router.patch('/', authController.protect, userInfoController.insertMyInfo);

module.exports = router;
