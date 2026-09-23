const express = require('express');
const authController = require('../controllers/authController');
const classroomTransferController = require('../controllers/classroomTransferController');

const router = express.Router();

// Literal paths before '/:id'.

/* student */
router.get(
  '/mine',
  authController.protect,
  classroomTransferController.getMyTransferRequests,
);
router.post(
  '/',
  authController.protect,
  classroomTransferController.createTransferRequest,
);

/* admin backstop for classrooms with no usable home teacher */
router.get(
  '/all',
  authController.protect,
  authController.restrictTo('admin'),
  classroomTransferController.listAllTransferRequests,
);

/* teacher — requests to leave a classroom I home-teach */
router.get(
  '/',
  authController.protect,
  authController.restrictTo('teacher'),
  classroomTransferController.getIncomingTransferRequests,
);

router.patch(
  '/:id/cancel',
  authController.protect,
  classroomTransferController.cancelTransferRequest,
);
router.patch(
  '/:id',
  authController.protect,
  authController.restrictTo('teacher'),
  classroomTransferController.decideTransferRequest,
);

module.exports = router;
