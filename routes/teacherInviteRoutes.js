const express = require('express');
const authController = require('../controllers/authController');
const teacherInviteController = require('../controllers/teacherInviteController');

const router = express.Router();

// The school's teacher email list. Admin only — the `teacher` role can only ever
// originate from a row written here.
router.post(
  '/csv',
  authController.protect,
  authController.restrictTo('admin'),
  teacherInviteController.uploadInviteCsv,
  teacherInviteController.createTeacherInvitesFromCsv,
);
router.post('/', authController.protect,
  authController.restrictTo('admin'), teacherInviteController.createTeacherInvites);
router.get('/', authController.protect,
  authController.restrictTo('admin'), teacherInviteController.listTeacherInvites);
router.patch('/:id', authController.protect,
  authController.restrictTo('admin'), teacherInviteController.updateTeacherInvite);
router.delete('/:id', authController.protect,
  authController.restrictTo('admin'), teacherInviteController.deleteTeacherInvite);

module.exports = router;
