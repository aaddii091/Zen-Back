const express = require('express');
const authController = require('../controllers/authController');
const shortCourseProgressController = require('../controllers/shortCourseProgressController');

const router = express.Router();

router.get(
  '/my-progress',
  authController.protect,
  shortCourseProgressController.getMyShortCourseProgress
);

router.patch(
  '/my-progress',
  authController.protect,
  shortCourseProgressController.upsertMyShortCourseProgress
);

module.exports = router;
