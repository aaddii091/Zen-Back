const express = require('express');
const authController = require('../controllers/authController');
const classroomController = require('../controllers/classroomController');

const router = express.Router();

// Literal paths MUST be declared before '/:id', or Express binds id = 'mine'.

/* teacher */
router.get(
  '/mine',
  authController.protect,
  authController.restrictTo('teacher'),
  classroomController.getMyClassrooms,
);
router.get(
  '/students/search',
  authController.protect,
  authController.restrictTo('teacher'),
  classroomController.searchMyStudents,
);

/* student */
router.get(
  '/available',
  authController.protect,
  classroomController.getAvailableClassrooms,
);
router.get(
  '/my-classroom',
  authController.protect,
  classroomController.getMyClassroom,
);

/* admin */
router.post('/', authController.protect,
  authController.restrictTo('admin'), classroomController.createClassroom);
router.get('/', authController.protect,
  authController.restrictTo('admin'), classroomController.listClassrooms);

/* parameterised */
router.get(
  '/:id/students',
  authController.protect,
  authController.restrictTo('teacher'),
  classroomController.getClassroomStudents,
);
router.post(
  '/:id/join',
  authController.protect,
  classroomController.joinClassroom,
);
router.patch('/:id', authController.protect,
  authController.restrictTo('admin'), classroomController.updateClassroom);
router.patch(
  '/:id/home-teacher',
  authController.protect,
  authController.restrictTo('admin'),
  classroomController.setHomeTeacher,
);
router.post(
  '/:id/teachers',
  authController.protect,
  authController.restrictTo('admin'),
  classroomController.addClassroomTeachers,
);
router.delete(
  '/:id/teachers/:userId',
  authController.protect,
  authController.restrictTo('admin'),
  classroomController.removeClassroomTeacher,
);

module.exports = router;
