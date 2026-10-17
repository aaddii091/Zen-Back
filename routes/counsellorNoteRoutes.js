const express = require('express');
const authController = require('../controllers/authController');
const counsellorNoteController = require('../controllers/counsellorNoteController');

const router = express.Router();

// Literal paths MUST be declared before '/:id', or Express binds id = 'shared'.

/* teacher — read-only, shared notes only */
router.get(
  '/shared/student/:id',
  authController.protect,
  authController.restrictTo('teacher'),
  counsellorNoteController.listSharedNotesForStudent,
);

/* counsellor */
router.post(
  '/',
  authController.protect,
  authController.restrictTo('therapist'),
  counsellorNoteController.createNote,
);
router.get(
  '/student/:id',
  authController.protect,
  authController.restrictTo('therapist'),
  counsellorNoteController.listNotesForStudent,
);
router.patch(
  '/:id',
  authController.protect,
  authController.restrictTo('therapist'),
  counsellorNoteController.updateNote,
);
router.patch(
  '/:id/visibility',
  authController.protect,
  authController.restrictTo('therapist'),
  counsellorNoteController.setNoteVisibility,
);
router.delete(
  '/:id',
  authController.protect,
  authController.restrictTo('therapist'),
  counsellorNoteController.deleteNote,
);

/* attachments */
router.post(
  '/:id/attachments/presign',
  authController.protect,
  authController.restrictTo('therapist'),
  counsellorNoteController.presignAttachmentUpload,
);
router.post(
  '/:id/attachments',
  authController.protect,
  authController.restrictTo('therapist'),
  counsellorNoteController.confirmAttachment,
);
// Teachers reach this one too, for a note that was shared with them.
router.get(
  '/:id/attachments/:attachmentId/url',
  authController.protect,
  authController.restrictTo('therapist', 'teacher'),
  counsellorNoteController.getAttachmentUrl,
);
router.delete(
  '/:id/attachments/:attachmentId',
  authController.protect,
  authController.restrictTo('therapist'),
  counsellorNoteController.deleteAttachment,
);

module.exports = router;
